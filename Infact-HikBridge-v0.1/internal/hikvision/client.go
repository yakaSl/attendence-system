package hikvision

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"infactsolutions/hikbridge/internal/model"
)

const (
	maxResponseBytes = 4 << 20
	maxSearchPages   = 4000
)

func newSearchID(prefix string) string {
	return prefix + strconv.FormatInt(time.Now().UnixNano(), 36)
}

type Options struct {
	BaseURL    string
	DeviceID   string
	Username   string
	Password   string
	PageSize   int
	Location   *time.Location
	Timeout    time.Duration
	RetryCount int
	HTTPClient *http.Client
}

type Client struct {
	baseURL  string
	deviceID string
	http     *digestClient
	pageSize int
	location *time.Location
	retries  int

	metadataMu   sync.RWMutex
	deviceSerial string
}

type HTTPError struct {
	StatusCode int
	Operation  string
	Message    string
}

func (e *HTTPError) Error() string {
	if e.StatusCode == http.StatusUnauthorized {
		return fmt.Sprintf("%s: Hikvision authentication failed (HTTP 401)", e.Operation)
	}
	if e.Message == "" {
		return fmt.Sprintf("%s: Hikvision returned HTTP %d", e.Operation, e.StatusCode)
	}
	return fmt.Sprintf("%s: Hikvision returned HTTP %d: %s", e.Operation, e.StatusCode, e.Message)
}

type DeviceInfo struct {
	Name            string          `json:"name,omitempty"`
	Model           string          `json:"model,omitempty"`
	SerialNumber    string          `json:"serialNumber,omitempty"`
	FirmwareVersion string          `json:"firmwareVersion,omitempty"`
	FirmwareDate    string          `json:"firmwareDate,omitempty"`
	MACAddress      string          `json:"macAddress,omitempty"`
	Raw             json.RawMessage `json:"raw,omitempty"`
}

type DeviceTime struct {
	LocalTime string          `json:"localTime,omitempty"`
	TimeZone  string          `json:"timeZone,omitempty"`
	TimeMode  string          `json:"timeMode,omitempty"`
	Parsed    *time.Time      `json:"parsed,omitempty"`
	Raw       json.RawMessage `json:"raw,omitempty"`
}

type User struct {
	EmployeeNo       string          `json:"employeeNo"`
	Name             string          `json:"name,omitempty"`
	CardNo           string          `json:"cardNo,omitempty"`
	FingerprintCount *int            `json:"fingerprintCount,omitempty"`
	UserType         string          `json:"userType,omitempty"`
	Raw              json.RawMessage `json:"raw"`
}

type EventSearchResult struct {
	Events   []model.AttendanceEvent
	Issues   []model.ParseIssue
	RawPages []json.RawMessage
}

func New(options Options) *Client {
	baseURL := strings.TrimRight(options.BaseURL, "/")
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 12 * time.Second
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}
	pageSize := options.PageSize
	if pageSize <= 0 || pageSize > 30 {
		pageSize = 30
	}
	location := options.Location
	if location == nil {
		location = time.Local
	}
	retries := options.RetryCount
	if retries < 0 {
		retries = 0
	}
	return &Client{
		baseURL:  baseURL,
		deviceID: options.DeviceID,
		http:     newDigestClient(httpClient, options.Username, options.Password),
		pageSize: pageSize,
		location: location,
		retries:  retries,
	}
}

func (c *Client) request(ctx context.Context, method, path string, payload any) ([]byte, int, error) {
	var encoded []byte
	var err error
	if payload != nil {
		encoded, err = json.Marshal(payload)
		if err != nil {
			return nil, 0, fmt.Errorf("encode Hikvision request: %w", err)
		}
	}
	operation := method + " " + strings.SplitN(path, "?", 2)[0]
	for attempt := 0; ; attempt++ {
		var body io.Reader
		if encoded != nil {
			body = bytes.NewReader(encoded)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
		if err != nil {
			return nil, 0, fmt.Errorf("create Hikvision request: %w", err)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Accept", "application/json, application/xml;q=0.9, */*;q=0.8")
		resp, err := c.http.Do(req)
		if err != nil {
			if attempt < c.retries && retryableRequestError(ctx, err) {
				if err := waitForRetry(ctx, attempt); err != nil {
					return nil, 0, err
				}
				continue
			}
			return nil, 0, fmt.Errorf("%s: %w", operation, err)
		}
		b, readErr := readDeviceResponse(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return nil, resp.StatusCode, fmt.Errorf("%s: %w", operation, readErr)
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return b, resp.StatusCode, nil
		}
		httpErr := &HTTPError{
			StatusCode: resp.StatusCode,
			Operation:  operation,
			Message:    safeDeviceErrorMessage(b),
		}
		if attempt < c.retries && retryableStatus(resp.StatusCode) {
			if err := waitForRetry(ctx, attempt); err != nil {
				return nil, resp.StatusCode, err
			}
			continue
		}
		return b, resp.StatusCode, httpErr
	}
}

func readDeviceResponse(body io.Reader) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Hikvision response: %w", err)
	}
	if len(b) > maxResponseBytes {
		return nil, fmt.Errorf("Hikvision response exceeds %d bytes", maxResponseBytes)
	}
	return b, nil
}

func safeDeviceErrorMessage(body []byte) string {
	var jsonStatus struct {
		ResponseStatus struct {
			StatusString  string `json:"statusString"`
			SubStatusCode string `json:"subStatusCode"`
			ErrorCode     int    `json:"errorCode"`
		} `json:"ResponseStatus"`
	}
	if err := json.Unmarshal(body, &jsonStatus); err == nil {
		parts := []string{}
		if jsonStatus.ResponseStatus.StatusString != "" {
			parts = append(parts, jsonStatus.ResponseStatus.StatusString)
		}
		if jsonStatus.ResponseStatus.SubStatusCode != "" {
			parts = append(parts, jsonStatus.ResponseStatus.SubStatusCode)
		}
		if jsonStatus.ResponseStatus.ErrorCode != 0 {
			parts = append(parts, fmt.Sprintf("code=%d", jsonStatus.ResponseStatus.ErrorCode))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	var xmlStatus struct {
		XMLName      xml.Name `xml:"ResponseStatus"`
		StatusString string   `xml:"statusString"`
		SubStatus    string   `xml:"subStatusCode"`
		ErrorCode    int      `xml:"errorCode"`
	}
	if err := xml.Unmarshal(body, &xmlStatus); err == nil {
		parts := []string{}
		if xmlStatus.StatusString != "" {
			parts = append(parts, xmlStatus.StatusString)
		}
		if xmlStatus.SubStatus != "" {
			parts = append(parts, xmlStatus.SubStatus)
		}
		if xmlStatus.ErrorCode != 0 {
			parts = append(parts, fmt.Sprintf("code=%d", xmlStatus.ErrorCode))
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	return "device rejected the request"
}

func retryableRequestError(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var networkError net.Error
	return errors.As(err, &networkError)
}

func retryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func waitForRetry(ctx context.Context, attempt int) error {
	delay := time.Duration(attempt+1) * 250 * time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) TestConnection(ctx context.Context) error {
	_, err := c.DeviceInfo(ctx)
	return err
}

func (c *Client) DeviceInfo(ctx context.Context) (DeviceInfo, error) {
	b, _, err := c.request(ctx, http.MethodGet, "/ISAPI/System/deviceInfo?format=json", nil)
	if err != nil {
		return DeviceInfo{}, err
	}
	info, err := parseDeviceInfo(b)
	if err != nil {
		return DeviceInfo{}, err
	}
	c.metadataMu.Lock()
	c.deviceSerial = info.SerialNumber
	c.metadataMu.Unlock()
	return info, nil
}

func parseDeviceInfo(body []byte) (DeviceInfo, error) {
	var jsonPayload struct {
		DeviceInfo struct {
			DeviceName           string `json:"deviceName"`
			Model                string `json:"model"`
			SerialNumber         string `json:"serialNumber"`
			FirmwareVersion      string `json:"firmwareVersion"`
			FirmwareReleasedDate string `json:"firmwareReleasedDate"`
			MACAddress           string `json:"macAddress"`
		} `json:"DeviceInfo"`
	}
	if err := json.Unmarshal(body, &jsonPayload); err == nil &&
		(jsonPayload.DeviceInfo.Model != "" || jsonPayload.DeviceInfo.SerialNumber != "") {
		return DeviceInfo{
			Name:            jsonPayload.DeviceInfo.DeviceName,
			Model:           jsonPayload.DeviceInfo.Model,
			SerialNumber:    jsonPayload.DeviceInfo.SerialNumber,
			FirmwareVersion: jsonPayload.DeviceInfo.FirmwareVersion,
			FirmwareDate:    jsonPayload.DeviceInfo.FirmwareReleasedDate,
			MACAddress:      jsonPayload.DeviceInfo.MACAddress,
			Raw:             append(json.RawMessage(nil), body...),
		}, nil
	}
	var xmlPayload struct {
		XMLName              xml.Name `xml:"DeviceInfo"`
		DeviceName           string   `xml:"deviceName"`
		Model                string   `xml:"model"`
		SerialNumber         string   `xml:"serialNumber"`
		FirmwareVersion      string   `xml:"firmwareVersion"`
		FirmwareReleasedDate string   `xml:"firmwareReleasedDate"`
		MACAddress           string   `xml:"macAddress"`
	}
	if err := xml.Unmarshal(body, &xmlPayload); err != nil {
		return DeviceInfo{}, fmt.Errorf("decode Hikvision device info: %w", err)
	}
	if xmlPayload.Model == "" && xmlPayload.SerialNumber == "" {
		return DeviceInfo{}, errors.New("Hikvision device info omitted model and serial number")
	}
	return DeviceInfo{
		Name:            xmlPayload.DeviceName,
		Model:           xmlPayload.Model,
		SerialNumber:    xmlPayload.SerialNumber,
		FirmwareVersion: xmlPayload.FirmwareVersion,
		FirmwareDate:    xmlPayload.FirmwareReleasedDate,
		MACAddress:      xmlPayload.MACAddress,
		Raw:             append(json.RawMessage(nil), body...),
	}, nil
}

func (c *Client) DeviceTime(ctx context.Context) (DeviceTime, error) {
	b, _, err := c.request(ctx, http.MethodGet, "/ISAPI/System/time?format=json", nil)
	if err != nil {
		return DeviceTime{}, err
	}
	result, err := parseDeviceTime(b, c.location)
	if err != nil {
		return DeviceTime{}, err
	}
	return result, nil
}

func parseDeviceTime(body []byte, location *time.Location) (DeviceTime, error) {
	var jsonPayload struct {
		Time struct {
			LocalTime string `json:"localTime"`
			TimeZone  string `json:"timeZone"`
			TimeMode  string `json:"timeMode"`
		} `json:"Time"`
	}
	result := DeviceTime{Raw: append(json.RawMessage(nil), body...)}
	if err := json.Unmarshal(body, &jsonPayload); err == nil && jsonPayload.Time.LocalTime != "" {
		result.LocalTime = jsonPayload.Time.LocalTime
		result.TimeZone = jsonPayload.Time.TimeZone
		result.TimeMode = jsonPayload.Time.TimeMode
	} else {
		var xmlPayload struct {
			XMLName   xml.Name `xml:"Time"`
			LocalTime string   `xml:"localTime"`
			TimeZone  string   `xml:"timeZone"`
			TimeMode  string   `xml:"timeMode"`
		}
		if err := xml.Unmarshal(body, &xmlPayload); err != nil {
			return DeviceTime{}, fmt.Errorf("decode Hikvision device time: %w", err)
		}
		result.LocalTime = xmlPayload.LocalTime
		result.TimeZone = xmlPayload.TimeZone
		result.TimeMode = xmlPayload.TimeMode
	}
	if result.LocalTime == "" {
		return DeviceTime{}, errors.New("Hikvision device time omitted localTime")
	}
	parsed, err := parseDeviceTimestamp(result.LocalTime, location)
	if err != nil {
		return DeviceTime{}, fmt.Errorf("parse Hikvision device time: %w", err)
	}
	result.Parsed = &parsed
	return result, nil
}

func (c *Client) UserCount(ctx context.Context) (int, error) {
	b, _, err := c.request(ctx, http.MethodGet, "/ISAPI/AccessControl/UserInfo/Count?format=json", nil)
	if err != nil {
		return 0, err
	}
	var response struct {
		UserInfoCount struct {
			UserNumber int `json:"userNumber"`
		} `json:"UserInfoCount"`
	}
	if err := json.Unmarshal(b, &response); err != nil {
		return 0, fmt.Errorf("decode Hikvision user count: %w", err)
	}
	return response.UserInfoCount.UserNumber, nil
}

type userInfo struct {
	EmployeeNo string `json:"employeeNo"`
	Name       string `json:"name"`
	UserType   string `json:"userType"`
	CardNo     string `json:"cardNo"`
	NumOfFP    *int   `json:"numOfFP"`
	CardInfo   []struct {
		CardNo string `json:"cardNo"`
	} `json:"CardInfo"`
}

type userSearchResponse struct {
	UserInfoSearch struct {
		SearchID           string            `json:"searchID"`
		TotalMatches       int               `json:"totalMatches"`
		ResponseStatusStrg string            `json:"responseStatusStrg"`
		NumOfMatches       int               `json:"numOfMatches"`
		UserInfo           []json.RawMessage `json:"UserInfo"`
	} `json:"UserInfoSearch"`
}

func (c *Client) SearchUsers(ctx context.Context) ([]User, error) {
	searchID := newSearchID("u")
	position := 0
	users := make([]User, 0)
	for page := 0; page < maxSearchPages; page++ {
		payload := map[string]any{
			"UserInfoSearchCond": map[string]any{
				"searchID":             searchID,
				"searchResultPosition": position,
				"maxResults":           c.pageSize,
			},
		}
		b, _, err := c.request(ctx, http.MethodPost, "/ISAPI/AccessControl/UserInfo/Search?format=json", payload)
		if err != nil {
			return nil, err
		}
		var response userSearchResponse
		if err := json.Unmarshal(b, &response); err != nil {
			return nil, fmt.Errorf("decode Hikvision user search page %d: %w", page+1, err)
		}
		pageUsers := response.UserInfoSearch.UserInfo
		if err := validateSearchProgress(searchID, response.UserInfoSearch.SearchID, position, response.UserInfoSearch.TotalMatches, response.UserInfoSearch.NumOfMatches, len(pageUsers)); err != nil {
			return nil, fmt.Errorf("Hikvision user pagination: %w", err)
		}
		for _, raw := range pageUsers {
			var info userInfo
			if err := json.Unmarshal(raw, &info); err != nil {
				return nil, fmt.Errorf("decode Hikvision user at position %d: %w", position+len(users), err)
			}
			cardNo := info.CardNo
			if cardNo == "" && len(info.CardInfo) > 0 {
				cardNo = info.CardInfo[0].CardNo
			}
			users = append(users, User{
				EmployeeNo:       info.EmployeeNo,
				Name:             info.Name,
				CardNo:           cardNo,
				FingerprintCount: info.NumOfFP,
				UserType:         info.UserType,
				Raw:              append(json.RawMessage(nil), raw...),
			})
		}
		if searchComplete(position, len(pageUsers), response.UserInfoSearch.TotalMatches, response.UserInfoSearch.ResponseStatusStrg) {
			return users, nil
		}
		position += len(pageUsers)
	}
	return nil, errors.New("Hikvision user pagination exceeded safety limit")
}

type acsInfo struct {
	Major             int    `json:"major"`
	Minor             int    `json:"minor"`
	Time              string `json:"time"`
	CardNo            string `json:"cardNo"`
	Name              string `json:"name"`
	CardReaderNo      int    `json:"cardReaderNo"`
	DoorNo            int    `json:"doorNo"`
	EmployeeNoString  string `json:"employeeNoString"`
	SerialNo          int64  `json:"serialNo"`
	CurrentVerifyMode string `json:"currentVerifyMode"`
	AttendanceStatus  string `json:"attendanceStatus"`
}

type acsResponse struct {
	AcsEvent struct {
		SearchID           string            `json:"searchID"`
		TotalMatches       int               `json:"totalMatches"`
		ResponseStatusStrg string            `json:"responseStatusStrg"`
		NumOfMatches       int               `json:"numOfMatches"`
		InfoList           []json.RawMessage `json:"InfoList"`
	} `json:"AcsEvent"`
}

func formatDeviceTime(t time.Time) string {
	return t.Format("2006-01-02T15:04:05-07:00")
}

func parseDeviceTimestamp(value string, location *time.Location) (time.Time, error) {
	if value == "" {
		return time.Time{}, errors.New("timestamp is missing")
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05-0700"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported timestamp %q", value)
}

func (c *Client) SearchEvents(ctx context.Context, start, end time.Time) ([]model.AttendanceEvent, error) {
	result, err := c.SearchEventsDetailed(ctx, start, end)
	if err != nil {
		return nil, err
	}
	return result.Events, nil
}

func (c *Client) SearchEventsDetailed(ctx context.Context, start, end time.Time) (EventSearchResult, error) {
	if end.Before(start) {
		return EventSearchResult{}, errors.New("event search end must not be before start")
	}
	searchID := newSearchID("e")
	position := 0
	result := EventSearchResult{}
	receivedAt := time.Now().UTC()
	c.metadataMu.RLock()
	deviceSerial := c.deviceSerial
	c.metadataMu.RUnlock()

	for page := 0; page < maxSearchPages; page++ {
		payload := map[string]any{
			"AcsEventCond": map[string]any{
				"searchID":             searchID,
				"searchResultPosition": position,
				"maxResults":           c.pageSize,
				"major":                5,
				"minor":                0,
				"startTime":            formatDeviceTime(start),
				"endTime":              formatDeviceTime(end),
				"picEnable":            false,
			},
		}
		b, _, err := c.request(ctx, http.MethodPost, "/ISAPI/AccessControl/AcsEvent?format=json", payload)
		if err != nil {
			return EventSearchResult{}, err
		}
		result.RawPages = append(result.RawPages, append(json.RawMessage(nil), b...))
		var response acsResponse
		if err := json.Unmarshal(b, &response); err != nil {
			return EventSearchResult{}, fmt.Errorf("decode Hikvision event search page %d: %w", page+1, err)
		}
		pageEvents := response.AcsEvent.InfoList
		if err := validateSearchProgress(searchID, response.AcsEvent.SearchID, position, response.AcsEvent.TotalMatches, response.AcsEvent.NumOfMatches, len(pageEvents)); err != nil {
			return EventSearchResult{}, fmt.Errorf("Hikvision event pagination: %w", err)
		}
		for index, raw := range pageEvents {
			var info acsInfo
			if err := json.Unmarshal(raw, &info); err != nil {
				result.Issues = append(result.Issues, model.ParseIssue{
					DeviceID: c.deviceID,
					Page:     page + 1,
					Index:    index,
					Message:  "decode event: " + err.Error(),
					Raw:      append(json.RawMessage(nil), raw...),
				})
				continue
			}
			eventTime, err := parseDeviceTimestamp(info.Time, c.location)
			if err != nil {
				result.Issues = append(result.Issues, model.ParseIssue{
					DeviceID: c.deviceID,
					Page:     page + 1,
					Index:    index,
					Message:  err.Error(),
					Raw:      append(json.RawMessage(nil), raw...),
				})
				continue
			}
			event := model.AttendanceEvent{
				DeviceID:          c.deviceID,
				DeviceSerial:      deviceSerial,
				SerialNo:          info.SerialNo,
				EmployeeNo:        info.EmployeeNoString,
				Name:              info.Name,
				EventTime:         eventTime,
				Major:             info.Major,
				Minor:             info.Minor,
				AttendanceStatus:  info.AttendanceStatus,
				CurrentVerifyMode: info.CurrentVerifyMode,
				CardNo:            info.CardNo,
				CardReaderNo:      info.CardReaderNo,
				DoorNo:            info.DoorNo,
				Raw:               append(json.RawMessage(nil), raw...),
				ReceivedAt:        receivedAt,
			}
			event.ID = model.NewEventID(c.deviceID, event.SerialNo, event.EventTime, event.EmployeeNo, event.Major, event.Minor)
			result.Events = append(result.Events, event)
		}
		if searchComplete(position, len(pageEvents), response.AcsEvent.TotalMatches, response.AcsEvent.ResponseStatusStrg) {
			return result, nil
		}
		position += len(pageEvents)
	}
	return EventSearchResult{}, errors.New("Hikvision event pagination exceeded safety limit")
}

func validateSearchProgress(expectedSearchID, actualSearchID string, position, total, reported, actual int) error {
	if actualSearchID != "" && actualSearchID != expectedSearchID {
		return fmt.Errorf("response searchID %q does not match request", actualSearchID)
	}
	if reported != 0 && reported != actual {
		return fmt.Errorf("numOfMatches=%d but response contains %d records", reported, actual)
	}
	if total > position && actual == 0 {
		return fmt.Errorf("zero progress at position %d with totalMatches=%d", position, total)
	}
	if actual < 0 || position+actual > 100000 {
		return errors.New("pagination safety limit reached")
	}
	return nil
}

func searchComplete(position, actual, total int, status string) bool {
	if total > 0 {
		return position+actual >= total
	}
	return !strings.EqualFold(strings.TrimSpace(status), "MORE")
}

func NormalizeBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("base URL must start with http:// or https://")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("base URL host is missing")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("base URL must not contain credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("base URL must not contain a query or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return strings.TrimRight(parsed.String(), "/"), nil
}
