package syncer

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"infactsolutions/hikbridge/internal/model"
)

const ProtocolVersion = "1"

var commandIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var commandResultCodePattern = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

type Options struct {
	URL               string
	DeviceID          string
	BridgeKey         string
	Timeout           time.Duration
	AllowInsecureHTTP bool
	AgentVersion      string
	HTTPClient        *http.Client
	Now               func() time.Time
}

type Client struct {
	url          string
	deviceID     string
	key          []byte
	http         *http.Client
	now          func() time.Time
	agentVersion string
}

type requestPayload struct {
	ProtocolVersion string                  `json:"protocolVersion"`
	RequestID       string                  `json:"requestId"`
	DeviceID        string                  `json:"deviceId"`
	Probe           bool                    `json:"probe,omitempty"`
	AcceptCommands  bool                    `json:"acceptCommands,omitempty"`
	Status          *BridgeStatus           `json:"status,omitempty"`
	CommandResults  []model.CommandResult   `json:"commandResults,omitempty"`
	Events          []model.AttendanceEvent `json:"events"`
}

type BridgeStatus struct {
	DeviceConnected          bool       `json:"deviceConnected"`
	LastSuccessfulDevicePoll *time.Time `json:"lastSuccessfulDevicePoll,omitempty"`
	PendingEvents            int        `json:"pendingEvents"`
	DeviceModel              string     `json:"deviceModel,omitempty"`
	DeviceSerial             string     `json:"deviceSerial,omitempty"`
	FirmwareVersion          string     `json:"firmwareVersion,omitempty"`
}

type RejectedEvent struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

type Response struct {
	ProtocolVersion        string                `json:"protocolVersion"`
	RequestID              string                `json:"requestId"`
	DeviceID               string                `json:"deviceId"`
	OrganizationID         string                `json:"organizationId,omitempty"`
	BranchID               string                `json:"branchId,omitempty"`
	Accepted               []string              `json:"accepted"`
	Duplicates             []string              `json:"duplicates"`
	Rejected               []RejectedEvent       `json:"rejected"`
	Commands               []model.DeviceCommand `json:"commands"`
	AcknowledgedCommandIDs []string              `json:"acknowledgedCommandIds"`
}

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("cloud ingest HTTP %d (%s): %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("cloud ingest HTTP %d: %s", e.Status, e.Message)
}

func New(options Options) (*Client, error) {
	parsed, err := url.Parse(options.URL)
	if err != nil {
		return nil, fmt.Errorf("parse cloud ingest URL: %w", err)
	}
	if parsed.Scheme != "https" {
		if parsed.Scheme != "http" || !options.AllowInsecureHTTP || !isLoopbackHost(parsed.Hostname()) {
			return nil, errors.New("cloud ingest URL must use HTTPS; development HTTP is allowed only for loopback with allowInsecureHttp=true")
		}
	}
	if parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("cloud ingest URL must include a host and must not contain credentials")
	}
	if options.DeviceID == "" {
		return nil, errors.New("cloud device ID is required")
	}
	if len(options.BridgeKey) < 32 {
		return nil, errors.New("cloud bridge key must contain at least 32 characters")
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		url:          parsed.String(),
		deviceID:     options.DeviceID,
		key:          []byte(options.BridgeKey),
		http:         httpClient,
		now:          now,
		agentVersion: options.AgentVersion,
	}, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate request nonce: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ComputeSignature is shared by contract tests. The signature covers protocol
// version, device identity, timestamp, nonce, and the exact request body hash.
func ComputeSignature(key []byte, deviceID, timestamp, nonce string, body []byte) string {
	bodyDigest := sha256.Sum256(body)
	canonical := strings.Join([]string{
		"hikbridge-hmac-sha256",
		ProtocolVersion,
		deviceID,
		timestamp,
		nonce,
		hex.EncodeToString(bodyDigest[:]),
	}, "\n")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func (c *Client) Send(ctx context.Context, events []model.AttendanceEvent) (Response, error) {
	if len(events) == 0 {
		return Response{}, errors.New("cannot upload an empty event batch")
	}
	return c.send(ctx, false, events, nil, false, nil)
}

func (c *Client) Probe(ctx context.Context) (Response, error) {
	return c.send(ctx, true, []model.AttendanceEvent{}, nil, false, nil)
}

func (c *Client) ReportStatus(ctx context.Context, status BridgeStatus) (Response, error) {
	if status.PendingEvents < 0 {
		return Response{}, errors.New("pending event count cannot be negative")
	}
	return c.send(ctx, true, []model.AttendanceEvent{}, &status, false, nil)
}

func (c *Client) ExchangeCommands(ctx context.Context, results []model.CommandResult) (Response, error) {
	if len(results) > 20 {
		return Response{}, errors.New("cannot acknowledge more than 20 command results at once")
	}
	seen := make(map[string]struct{}, len(results))
	for _, result := range results {
		if !commandIDPattern.MatchString(result.CommandID) || (result.State != "succeeded" && result.State != "failed") {
			return Response{}, errors.New("command result has an invalid ID or state")
		}
		if _, duplicate := seen[result.CommandID]; duplicate {
			return Response{}, fmt.Errorf("command result repeats ID %s", result.CommandID)
		}
		seen[result.CommandID] = struct{}{}
		if (result.Code != "" && !commandResultCodePattern.MatchString(result.Code)) || len(result.Message) > 500 {
			return Response{}, fmt.Errorf("command result %s has invalid error details", result.CommandID)
		}
	}
	return c.send(ctx, true, []model.AttendanceEvent{}, nil, true, results)
}

func (c *Client) send(
	ctx context.Context,
	probe bool,
	events []model.AttendanceEvent,
	status *BridgeStatus,
	acceptCommands bool,
	commandResults []model.CommandResult,
) (Response, error) {
	nonce, err := newNonce()
	if err != nil {
		return Response{}, err
	}
	payload := requestPayload{
		ProtocolVersion: ProtocolVersion,
		RequestID:       nonce,
		DeviceID:        c.deviceID,
		Probe:           probe,
		AcceptCommands:  acceptCommands,
		Status:          status,
		CommandResults:  commandResults,
		Events:          events,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Response{}, fmt.Errorf("encode cloud request: %w", err)
	}
	timestamp := strconv.FormatInt(c.now().Unix(), 10)
	signature := ComputeSignature(c.key, c.deviceID, timestamp, nonce, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("create cloud request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HikBridge-Version", ProtocolVersion)
	req.Header.Set("X-HikBridge-Device", c.deviceID)
	req.Header.Set("X-HikBridge-Timestamp", timestamp)
	req.Header.Set("X-HikBridge-Nonce", nonce)
	req.Header.Set("X-HikBridge-Signature", signature)
	if c.agentVersion != "" {
		req.Header.Set("X-HikBridge-Agent-Version", c.agentVersion)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("send cloud request: %w", err)
	}
	defer resp.Body.Close()
	b, err := readLimited(resp.Body, 1<<20)
	if err != nil {
		return Response{}, fmt.Errorf("read cloud response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Response{}, decodeAPIError(resp.StatusCode, b)
	}
	var result Response
	if err := json.Unmarshal(b, &result); err != nil {
		return Response{}, fmt.Errorf("decode cloud acknowledgement: %w", err)
	}
	if err := validateResponse(result, payload); err != nil {
		return Response{}, fmt.Errorf("invalid cloud acknowledgement: %w", err)
	}
	return result, nil
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return b, nil
}

func decodeAPIError(status int, body []byte) error {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &payload)
	code, message := payload.Error.Code, payload.Error.Message
	if code == "" {
		code = payload.Code
	}
	if message == "" {
		message = payload.Message
	}
	if message == "" {
		message = http.StatusText(status)
	}
	if len(message) > 500 {
		message = message[:500]
	}
	return &APIError{Status: status, Code: code, Message: message}
}

func validateResponse(response Response, request requestPayload) error {
	if response.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("protocol version %q does not match %q", response.ProtocolVersion, ProtocolVersion)
	}
	if response.RequestID != request.RequestID {
		return errors.New("request ID does not match")
	}
	if response.DeviceID != request.DeviceID {
		return errors.New("device ID does not match")
	}
	if request.Probe {
		if response.OrganizationID == "" {
			return errors.New("probe response omitted organizationId")
		}
		if len(response.Accepted)+len(response.Duplicates)+len(response.Rejected) != 0 {
			return errors.New("probe response unexpectedly contains event results")
		}
		requestedResults := make(map[string]struct{}, len(request.CommandResults))
		for _, result := range request.CommandResults {
			if result.CommandID == "" {
				return errors.New("command result omitted command ID")
			}
			requestedResults[result.CommandID] = struct{}{}
		}
		acknowledged := make(map[string]struct{}, len(response.AcknowledgedCommandIDs))
		for _, id := range response.AcknowledgedCommandIDs {
			if _, exists := requestedResults[id]; !exists {
				return fmt.Errorf("response acknowledges unknown command result %s", id)
			}
			if _, duplicate := acknowledged[id]; duplicate {
				return fmt.Errorf("response repeats acknowledged command result %s", id)
			}
			acknowledged[id] = struct{}{}
		}
		if !request.AcceptCommands && len(response.Commands) != 0 {
			return errors.New("probe response included commands without permission")
		}
		if len(response.Commands) > 20 {
			return errors.New("probe response exceeds command limit")
		}
		seenCommands := make(map[string]struct{}, len(response.Commands))
		for _, command := range response.Commands {
			if !commandIDPattern.MatchString(command.ID) || (command.Type != model.CommandUpsertUser && command.Type != model.CommandEnrollFingerprint) {
				return errors.New("probe response contains an invalid command")
			}
			if _, duplicate := seenCommands[command.ID]; duplicate {
				return fmt.Errorf("probe response repeats command %s", command.ID)
			}
			seenCommands[command.ID] = struct{}{}
			if len(command.Payload.EmployeeID) < 1 || len(command.Payload.EmployeeID) > 128 ||
				len(command.Payload.EmployeeNo) < 1 || len(command.Payload.EmployeeNo) > 32 ||
				len(command.Payload.Name) < 1 || len(command.Payload.Name) > 128 || command.IssuedAt.IsZero() ||
				command.ExpiresAt.IsZero() || !command.ExpiresAt.After(command.IssuedAt) {
				return fmt.Errorf("command %s has an incomplete payload", command.ID)
			}
			if command.Type == model.CommandEnrollFingerprint && (command.Payload.FingerPrintID < 1 || command.Payload.FingerPrintID > 10) {
				return fmt.Errorf("command %s has an invalid fingerprint ID", command.ID)
			}
		}
		return nil
	}
	if len(response.Commands) != 0 || len(response.AcknowledgedCommandIDs) != 0 {
		return errors.New("event acknowledgement unexpectedly contains command data")
	}

	requested := make(map[string]struct{}, len(request.Events))
	for _, event := range request.Events {
		if event.ID == "" {
			return errors.New("request contains event without an ID")
		}
		if _, exists := requested[event.ID]; exists {
			return fmt.Errorf("request repeats event ID %s", event.ID)
		}
		requested[event.ID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(requested))
	check := func(id string) error {
		if _, exists := requested[id]; !exists {
			return fmt.Errorf("response contains unknown event ID %s", id)
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("response repeats event ID %s", id)
		}
		seen[id] = struct{}{}
		return nil
	}
	for _, id := range response.Accepted {
		if err := check(id); err != nil {
			return err
		}
	}
	for _, id := range response.Duplicates {
		if err := check(id); err != nil {
			return err
		}
	}
	for _, rejected := range response.Rejected {
		if rejected.Code == "" {
			return fmt.Errorf("rejection for %s has no code", rejected.ID)
		}
		if err := check(rejected.ID); err != nil {
			return err
		}
	}
	if len(seen) != len(requested) {
		return fmt.Errorf("response accounts for %d of %d events", len(seen), len(requested))
	}
	return nil
}
