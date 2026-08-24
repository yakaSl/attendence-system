package syncer

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infactsolutions/hikbridge/internal/model"
)

const testBridgeKey = "0123456789abcdef0123456789abcdef"

func cloudEvent(serial int64) model.AttendanceEvent {
	timestamp := time.Date(2026, 8, 23, 8, 47, int(serial%60), 0, time.UTC)
	event := model.AttendanceEvent{
		DeviceID:   "office-main-01",
		SerialNo:   serial,
		EmployeeNo: "17",
		EventTime:  timestamp,
		Major:      5,
		Minor:      75,
		Raw:        []byte(`{"source":"fixture"}`),
		ReceivedAt: timestamp,
	}
	event.ID = model.NewEventID(event.DeviceID, event.SerialNo, event.EventTime, event.EmployeeNo, event.Major, event.Minor)
	return event
}

func newTestCloudClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := New(Options{
		URL:               server.URL,
		DeviceID:          "office-main-01",
		BridgeKey:         testBridgeKey,
		AllowInsecureHTTP: true,
		HTTPClient:        server.Client(),
		Now: func() time.Time {
			return time.Unix(1787494635, 0)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestComputeSignatureVector(t *testing.T) {
	body := []byte(`{"deviceId":"office-main-01","events":[]}`)
	got := ComputeSignature(
		[]byte(testBridgeKey),
		"office-main-01",
		"1787494635",
		"00112233445566778899aabbccddeeff",
		body,
	)
	const want = "37e87a76af464598fe05713fa85b7b75de949e865c5ef82947a6329d9d0506c7"
	if got != want {
		t.Fatalf("signature = %s", got)
	}
}

func TestSendSignsExactBodyAndAcceptsEventSpecificResults(t *testing.T) {
	events := []model.AttendanceEvent{cloudEvent(4101), cloudEvent(4102), cloudEvent(4103)}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		device := request.Header.Get("X-HikBridge-Device")
		timestamp := request.Header.Get("X-HikBridge-Timestamp")
		nonce := request.Header.Get("X-HikBridge-Nonce")
		wantSignature := ComputeSignature([]byte(testBridgeKey), device, timestamp, nonce, body)
		if request.Header.Get("X-HikBridge-Version") != ProtocolVersion || request.Header.Get("X-HikBridge-Signature") != wantSignature {
			t.Error("request signature or version is invalid")
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		var payload requestPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(response).Encode(Response{
			ProtocolVersion: ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			OrganizationID:  "org-1",
			Accepted:        []string{events[0].ID},
			Duplicates:      []string{events[1].ID},
			Rejected: []RejectedEvent{{
				ID:      events[2].ID,
				Code:    "invalid_event",
				Message: "timestamp out of range",
			}},
		})
	}))
	defer server.Close()
	result, err := newTestCloudClient(t, server).Send(context.Background(), events)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Accepted) != 1 || len(result.Duplicates) != 1 || len(result.Rejected) != 1 {
		t.Fatalf("unexpected acknowledgement: %+v", result)
	}
}

func TestSendRejectsIncompleteAcknowledgement(t *testing.T) {
	event := cloudEvent(4201)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload requestPayload
		_ = json.NewDecoder(request.Body).Decode(&payload)
		_ = json.NewEncoder(response).Encode(Response{
			ProtocolVersion: ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			Accepted:        []string{},
			Duplicates:      []string{},
			Rejected:        []RejectedEvent{},
		})
	}))
	defer server.Close()
	_, err := newTestCloudClient(t, server).Send(context.Background(), []model.AttendanceEvent{event})
	if err == nil || !strings.Contains(err.Error(), "accounts for 0 of 1") {
		t.Fatalf("expected incomplete acknowledgement error, got %v", err)
	}
}

func TestProbeCreatesNoEventsAndRequiresTenantResolution(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload requestPayload
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if !payload.Probe || len(payload.Events) != 0 {
			t.Error("probe carried events")
		}
		_ = json.NewEncoder(response).Encode(Response{
			ProtocolVersion: ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			OrganizationID:  "org-1",
			BranchID:        "branch-1",
			Accepted:        []string{},
			Duplicates:      []string{},
			Rejected:        []RejectedEvent{},
		})
	}))
	defer server.Close()
	result, err := newTestCloudClient(t, server).Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.OrganizationID != "org-1" || result.BranchID != "branch-1" {
		t.Fatalf("unexpected probe response: %+v", result)
	}
}

func TestReportStatusSignsBoundedDeviceHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload requestPayload
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if !payload.Probe || payload.Status == nil || payload.Status.DeviceConnected || payload.Status.PendingEvents != 7 {
			t.Errorf("unexpected status payload: %+v", payload)
		}
		_ = json.NewEncoder(response).Encode(Response{
			ProtocolVersion: ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			OrganizationID:  "org-1",
			Accepted:        []string{},
			Duplicates:      []string{},
			Rejected:        []RejectedEvent{},
		})
	}))
	defer server.Close()
	lastPoll := time.Date(2026, 8, 23, 11, 58, 0, 0, time.UTC)
	_, err := newTestCloudClient(t, server).ReportStatus(context.Background(), BridgeStatus{
		DeviceConnected:          false,
		LastSuccessfulDevicePoll: &lastPoll,
		PendingEvents:            7,
		DeviceModel:              "DS-K1A8503EF",
		FirmwareVersion:          "V3.3.0",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestExchangeCommandsCarriesResultsAndValidatesDeviceCommand(t *testing.T) {
	expiresAt := time.Date(2026, 8, 23, 13, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		var payload requestPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		wantSignature := ComputeSignature(
			[]byte(testBridgeKey),
			request.Header.Get("X-HikBridge-Device"),
			request.Header.Get("X-HikBridge-Timestamp"),
			request.Header.Get("X-HikBridge-Nonce"),
			body,
		)
		if request.Header.Get("X-HikBridge-Signature") != wantSignature || !payload.Probe || !payload.AcceptCommands {
			t.Error("command exchange was not authenticated or command-enabled")
		}
		if len(payload.CommandResults) != 1 || payload.CommandResults[0].CommandID != "previous-command" {
			t.Errorf("unexpected command results: %+v", payload.CommandResults)
		}
		_ = json.NewEncoder(response).Encode(Response{
			ProtocolVersion:        ProtocolVersion,
			RequestID:              payload.RequestID,
			DeviceID:               payload.DeviceID,
			OrganizationID:         "org-1",
			BranchID:               "branch-1",
			Accepted:               []string{},
			Duplicates:             []string{},
			Rejected:               []RejectedEvent{},
			AcknowledgedCommandIDs: []string{"previous-command"},
			Commands: []model.DeviceCommand{{
				ID:        "enroll-command",
				Type:      model.CommandEnrollFingerprint,
				IssuedAt:  expiresAt.Add(-time.Minute),
				ExpiresAt: expiresAt,
				Payload: model.UserCommandPayload{
					EmployeeID: "employee-17", EmployeeNo: "EMP-17", Name: "Kasun", FingerPrintID: 2,
				},
			}},
		})
	}))
	defer server.Close()
	result, err := newTestCloudClient(t, server).ExchangeCommands(context.Background(), []model.CommandResult{{
		CommandID: "previous-command", State: "succeeded",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Commands) != 1 || result.Commands[0].Payload.FingerPrintID != 2 ||
		len(result.AcknowledgedCommandIDs) != 1 {
		t.Fatalf("unexpected command exchange: %+v", result)
	}
}

func TestNewRequiresHTTPSOutsideExplicitLoopbackDevelopment(t *testing.T) {
	_, err := New(Options{URL: "http://example.com/events", DeviceID: "device-1", BridgeKey: testBridgeKey})
	if err == nil || !strings.Contains(err.Error(), "must use HTTPS") {
		t.Fatalf("expected HTTPS error, got %v", err)
	}
	_, err = New(Options{URL: "http://127.0.0.1:5001/events", DeviceID: "device-1", BridgeKey: testBridgeKey, AllowInsecureHTTP: true})
	if err != nil {
		t.Fatalf("explicit loopback development URL rejected: %v", err)
	}
}
