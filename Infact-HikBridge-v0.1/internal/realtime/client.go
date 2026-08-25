package realtime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"infactsolutions/hikbridge/internal/syncer"
)

const protocolVersion = "1"

var errAuthRevoked = errors.New("realtime authentication was revoked")

type Options struct {
	SessionURL        string
	DeviceID          string
	BridgeKey         string
	AgentVersion      string
	Timeout           time.Duration
	AllowInsecureHTTP bool
	HTTPClient        *http.Client
	StreamHTTPClient  *http.Client
	IdentityURL       string
	RefreshURL        string
	Now               func() time.Time
}

type Client struct {
	sessionURL        string
	deviceID          string
	key               []byte
	agentVersion      string
	http              *http.Client
	streamHTTP        *http.Client
	identityURL       string
	refreshURL        string
	now               func() time.Time
	allowInsecureHTTP bool
}

type sessionResponse struct {
	ProtocolVersion string `json:"protocolVersion"`
	RequestID       string `json:"requestId"`
	DeviceID        string `json:"deviceId"`
	OrganizationID  string `json:"organizationId"`
	DatabaseURL     string `json:"databaseUrl"`
	FirebaseAPIKey  string `json:"firebaseApiKey"`
	CustomToken     string `json:"customToken"`
	ControlPath     string `json:"controlPath"`
}

type credentials struct {
	IDToken      string
	RefreshToken string
	ExpiresAt    time.Time
}

func New(options Options) (*Client, error) {
	if err := validateEndpoint(options.SessionURL, options.AllowInsecureHTTP); err != nil {
		return nil, fmt.Errorf("realtime session URL: %w", err)
	}
	if options.DeviceID == "" || len(options.BridgeKey) < 32 {
		return nil, errors.New("realtime device ID and bridge key are required")
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}
	streamHTTP := options.StreamHTTPClient
	if streamHTTP == nil {
		streamHTTP = &http.Client{}
	}
	identityURL := options.IdentityURL
	if identityURL == "" {
		identityURL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
	}
	refreshURL := options.RefreshURL
	if refreshURL == "" {
		refreshURL = "https://securetoken.googleapis.com/v1/token"
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		sessionURL: options.SessionURL, deviceID: options.DeviceID, key: []byte(options.BridgeKey),
		agentVersion: options.AgentVersion, http: httpClient, streamHTTP: streamHTTP,
		identityURL: identityURL, refreshURL: refreshURL, now: now,
		allowInsecureHTTP: options.AllowInsecureHTTP,
	}, nil
}

func validateEndpoint(raw string, allowInsecure bool) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if parsed.Host == "" || parsed.User != nil {
		return errors.New("URL must include a host and must not contain credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("URL query and fragment are not allowed")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if parsed.Scheme == "http" && allowInsecure && (strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())) {
		return nil
	}
	return errors.New("URL must use HTTPS; development HTTP is allowed only for loopback")
}

func nonce() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate realtime request nonce: %w", err)
	}
	return hex.EncodeToString(value), nil
}

func (c *Client) createSession(ctx context.Context) (sessionResponse, error) {
	requestID, err := nonce()
	if err != nil {
		return sessionResponse{}, err
	}
	payload := struct {
		ProtocolVersion string `json:"protocolVersion"`
		RequestID       string `json:"requestId"`
		DeviceID        string `json:"deviceId"`
	}{protocolVersion, requestID, c.deviceID}
	body, err := json.Marshal(payload)
	if err != nil {
		return sessionResponse{}, fmt.Errorf("encode realtime session request: %w", err)
	}
	timestamp := strconv.FormatInt(c.now().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sessionURL, bytes.NewReader(body))
	if err != nil {
		return sessionResponse{}, fmt.Errorf("create realtime session request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HikBridge-Version", protocolVersion)
	req.Header.Set("X-HikBridge-Device", c.deviceID)
	req.Header.Set("X-HikBridge-Timestamp", timestamp)
	req.Header.Set("X-HikBridge-Nonce", requestID)
	req.Header.Set("X-HikBridge-Signature", syncer.ComputeSignature(c.key, c.deviceID, timestamp, requestID, body))
	if c.agentVersion != "" {
		req.Header.Set("X-HikBridge-Agent-Version", c.agentVersion)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return sessionResponse{}, fmt.Errorf("request realtime session: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := readLimited(resp.Body, 1<<20)
	if err != nil {
		return sessionResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sessionResponse{}, fmt.Errorf("realtime session HTTP %d: %s", resp.StatusCode, boundedMessage(responseBody))
	}
	var result sessionResponse
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return sessionResponse{}, fmt.Errorf("decode realtime session: %w", err)
	}
	expectedControlPath := fmt.Sprintf("bridgeRealtime/v1/control/%s/%s", result.OrganizationID, c.deviceID)
	if result.ProtocolVersion != protocolVersion || result.RequestID != requestID || result.DeviceID != c.deviceID ||
		result.OrganizationID == "" || result.DatabaseURL == "" || result.FirebaseAPIKey == "" ||
		result.CustomToken == "" || result.ControlPath != expectedControlPath {
		return sessionResponse{}, errors.New("realtime session response is incomplete or mismatched")
	}
	if err := validateEndpoint(result.DatabaseURL, c.allowInsecureHTTP); err != nil {
		return sessionResponse{}, fmt.Errorf("realtime database URL: %w", err)
	}
	return result, nil
}

func (c *Client) signIn(ctx context.Context, session sessionResponse) (credentials, error) {
	body, err := json.Marshal(map[string]any{"token": session.CustomToken, "returnSecureToken": true})
	if err != nil {
		return credentials{}, err
	}
	endpoint := session.FirebaseAPIKey
	parsed, err := url.Parse(c.identityURL)
	if err != nil {
		return credentials{}, err
	}
	query := parsed.Query()
	query.Set("key", endpoint)
	parsed.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return credentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return credentials{}, fmt.Errorf("exchange realtime custom token: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := readLimited(resp.Body, 1<<20)
	if err != nil {
		return credentials{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return credentials{}, fmt.Errorf("realtime token exchange HTTP %d: %s", resp.StatusCode, boundedMessage(responseBody))
	}
	var payload struct {
		IDToken      string `json:"idToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    string `json:"expiresIn"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return credentials{}, fmt.Errorf("decode realtime token exchange: %w", err)
	}
	seconds, err := strconv.Atoi(payload.ExpiresIn)
	if err != nil || seconds < 60 || payload.IDToken == "" || payload.RefreshToken == "" {
		return credentials{}, errors.New("realtime token exchange response is incomplete")
	}
	return credentials{IDToken: payload.IDToken, RefreshToken: payload.RefreshToken, ExpiresAt: c.now().Add(time.Duration(seconds) * time.Second)}, nil
}

func (c *Client) refresh(ctx context.Context, apiKey string, current credentials) (credentials, error) {
	values := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {current.RefreshToken}}
	parsed, err := url.Parse(c.refreshURL)
	if err != nil {
		return credentials{}, err
	}
	query := parsed.Query()
	query.Set("key", apiKey)
	parsed.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), strings.NewReader(values.Encode()))
	if err != nil {
		return credentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return credentials{}, fmt.Errorf("refresh realtime token: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := readLimited(resp.Body, 1<<20)
	if err != nil {
		return credentials{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return credentials{}, fmt.Errorf("realtime token refresh HTTP %d: %s", resp.StatusCode, boundedMessage(responseBody))
	}
	var payload struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    string `json:"expires_in"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return credentials{}, fmt.Errorf("decode realtime token refresh: %w", err)
	}
	seconds, err := strconv.Atoi(payload.ExpiresIn)
	if err != nil || seconds < 60 || payload.IDToken == "" || payload.RefreshToken == "" {
		return credentials{}, errors.New("realtime token refresh response is incomplete")
	}
	return credentials{IDToken: payload.IDToken, RefreshToken: payload.RefreshToken, ExpiresAt: c.now().Add(time.Duration(seconds) * time.Second)}, nil
}

func (c *Client) stream(ctx context.Context, session sessionResponse, token string, onSignal func(), onState func(bool)) error {
	base := strings.TrimRight(session.DatabaseURL, "/")
	path := strings.Trim(session.ControlPath, "/")
	endpoint, err := url.Parse(base + "/" + path + ".json")
	if err != nil {
		return err
	}
	query := endpoint.Query()
	query.Set("auth", token)
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.streamHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("connect realtime stream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := readLimited(resp.Body, 64<<10)
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return errAuthRevoked
		}
		return fmt.Errorf("realtime stream HTTP %d: %s", resp.StatusCode, boundedMessage(body))
	}
	onState(true)
	defer onState(false)

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	eventName := ""
	dataLines := make([]string, 0, 1)
	dispatch := func() error {
		data := strings.Join(dataLines, "\n")
		switch eventName {
		case "put", "patch":
			onSignal()
		case "auth_revoked":
			return errAuthRevoked
		case "cancel":
			return errors.New("realtime stream was cancelled by security rules")
		case "keep-alive", "":
		default:
			if data != "" {
				return fmt.Errorf("unsupported realtime event %q", eventName)
			}
		}
		eventName = ""
		dataLines = dataLines[:0]
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("read realtime stream: %w", err)
	}
	return ctx.Err()
}

// Run maintains the Firebase realtime stream until the context is cancelled.
// Authentication refreshes use Firebase Auth directly and do not invoke the
// bridge session Function again unless the refresh token is rejected.
func (c *Client) Run(ctx context.Context, onSignal func(), onState func(bool), onError func(error)) {
	backoff := time.Second
	for ctx.Err() == nil {
		session, err := c.createSession(ctx)
		if err != nil {
			onError(err)
			if !wait(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 5*time.Minute)
			continue
		}
		creds, err := c.signIn(ctx, session)
		if err != nil {
			onError(err)
			if !wait(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 5*time.Minute)
			continue
		}
		backoff = time.Second
		for ctx.Err() == nil {
			if c.now().Add(5 * time.Minute).After(creds.ExpiresAt) {
				creds, err = c.refresh(ctx, session.FirebaseAPIKey, creds)
				if err != nil {
					onError(err)
					break
				}
			}
			err = c.stream(ctx, session, creds.IDToken, onSignal, onState)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				onError(err)
			}
			if errors.Is(err, errAuthRevoked) {
				creds, err = c.refresh(ctx, session.FirebaseAPIKey, creds)
				if err != nil {
					onError(err)
					break
				}
			}
			if !wait(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, time.Minute)
		}
	}
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	value, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(value)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return value, nil
}

func boundedMessage(value []byte) string {
	message := strings.TrimSpace(string(value))
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}
