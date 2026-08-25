package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infactsolutions/hikbridge/internal/config"
	"infactsolutions/hikbridge/internal/model"
	"infactsolutions/hikbridge/internal/store"
	"infactsolutions/hikbridge/internal/syncer"
)

type connectedRealtimeStub struct{}

func (connectedRealtimeStub) Run(ctx context.Context, _ func(), onState func(bool), _ func(error)) {
	onState(true)
	<-ctx.Done()
}

func TestConnectedRealtimeCommandLoopMakesNoIdlePollingCalls(t *testing.T) {
	var exchanges atomic.Int32
	cloudServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		exchanges.Add(1)
		var payload struct {
			RequestID string `json:"requestId"`
			DeviceID  string `json:"deviceId"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		_ = json.NewEncoder(response).Encode(syncer.Response{
			ProtocolVersion:        syncer.ProtocolVersion,
			RequestID:              payload.RequestID,
			DeviceID:               payload.DeviceID,
			OrganizationID:         "org-1",
			BranchID:               "branch-1",
			Accepted:               []string{},
			Duplicates:             []string{},
			Rejected:               []syncer.RejectedEvent{},
			Commands:               []model.DeviceCommand{},
			AcknowledgedCommandIDs: []string{},
		})
	}))
	defer cloudServer.Close()
	runner, err := New(&config.Config{
		Service: config.ServiceConfig{DataDir: t.TempDir(), SyncIntervalSeconds: 1},
		Hikvision: config.HikvisionConfig{
			DeviceID: "office-main-01", BaseURL: "http://127.0.0.1:1", Username: "admin", Password: "password",
			PageSize: 30, TimeZone: "UTC", RequestTimeoutSeconds: 1, RetryCount: 1,
		},
		Cloud: config.CloudConfig{
			Enabled: true, IngestURL: cloudServer.URL, BridgeKey: "0123456789abcdef0123456789abcdef",
			BatchSize: 100, RequestTimeoutSeconds: 1, AllowInsecureHTTP: true,
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	runner.realtime = connectedRealtimeStub{}
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	done := make(chan struct{}, 1)
	go runner.commandLoop(ctx, done)
	<-done
	if calls := exchanges.Load(); calls != 1 {
		t.Fatalf("idle command exchanges = %d, want one startup reconciliation and no polling", calls)
	}
}

func TestEnrollmentSkipsDuplicateUserProvisioningAfterConfirmedUpsert(t *testing.T) {
	var userSearches atomic.Int32
	var userCreates atomic.Int32
	template := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 512)))
	deviceServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ISAPI/AccessControl/UserInfo/Search":
			userSearches.Add(1)
			_, _ = response.Write([]byte(`{"UserInfoSearch":{"searchID":"test","totalMatches":0,"numOfMatches":0,"UserInfo":[]}}`))
		case "/ISAPI/AccessControl/UserInfo/Record":
			userCreates.Add(1)
			_, _ = response.Write([]byte(`{"ResponseStatus":{"statusCode":1,"statusString":"OK"}}`))
		case "/ISAPI/AccessControl/CaptureFingerPrint":
			_, _ = response.Write([]byte(`<CaptureFingerPrint><fingerData>` + template +
				`</fingerData><fingerNo>2</fingerNo><fingerPrintQuality>87</fingerPrintQuality></CaptureFingerPrint>`))
		case "/ISAPI/AccessControl/FingerPrint/SetUp":
			_, _ = response.Write([]byte(`{"FingerPrintStatus":{"StatusList":[{"id":1,"cardReaderRecvStatus":"1"}]}}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer deviceServer.Close()

	runner, err := New(&config.Config{
		Service: config.ServiceConfig{DataDir: t.TempDir()},
		Hikvision: config.HikvisionConfig{
			DeviceID: "office-main-01", BaseURL: deviceServer.URL, Username: "admin", Password: "password",
			PageSize: 30, TimeZone: "UTC", RequestTimeoutSeconds: 2, RetryCount: 1,
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	expiresAt := time.Now().Add(time.Minute)
	upsertResult := runner.executeCommand(context.Background(), model.DeviceCommand{
		ID: "upsert-1", Type: model.CommandUpsertUser, ExpiresAt: expiresAt,
		Payload: model.UserCommandPayload{EmployeeID: "employee-1", EmployeeNo: "EMP-17", Name: "Kasun"},
	})
	if upsertResult.State != "succeeded" {
		t.Fatalf("upsert result = %+v", upsertResult)
	}
	enrollmentResult := runner.executeCommand(context.Background(), model.DeviceCommand{
		ID: "enroll-1", Type: model.CommandEnrollFingerprint, ExpiresAt: expiresAt,
		Payload: model.UserCommandPayload{
			EmployeeID: "employee-1", EmployeeNo: "EMP-17", Name: "Kasun", FingerPrintID: 2,
		},
	})
	if enrollmentResult.State != "succeeded" {
		t.Fatalf("enrollment result = %+v", enrollmentResult)
	}
	if searches, creates := userSearches.Load(), userCreates.Load(); searches != 1 || creates != 1 {
		t.Fatalf("terminal user operations: searches=%d creates=%d; enrollment repeated provisioning", searches, creates)
	}
}

func TestSlowCloudUploadDoesNotBlockDevicePolling(t *testing.T) {
	var polls atomic.Int32
	deviceServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ISAPI/System/deviceInfo":
			_, _ = response.Write([]byte(`{"DeviceInfo":{"model":"DS-K1A8503EF","serialNumber":"ABC"}}`))
		case "/ISAPI/AccessControl/AcsEvent":
			polls.Add(1)
			_, _ = response.Write([]byte(`{"AcsEvent":{"totalMatches":0,"responseStatusStrg":"OK","numOfMatches":0,"InfoList":[]}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer deviceServer.Close()

	cloudServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		var payload struct {
			ProtocolVersion string                  `json:"protocolVersion"`
			RequestID       string                  `json:"requestId"`
			DeviceID        string                  `json:"deviceId"`
			Events          []model.AttendanceEvent `json:"events"`
		}
		_ = json.Unmarshal(body, &payload)
		select {
		case <-request.Context().Done():
			return
		case <-time.After(3 * time.Second):
		}
		ids := make([]string, 0, len(payload.Events))
		for _, event := range payload.Events {
			ids = append(ids, event.ID)
		}
		_ = json.NewEncoder(response).Encode(syncer.Response{
			ProtocolVersion: syncer.ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			Accepted:        ids,
			Duplicates:      []string{},
			Rejected:        []syncer.RejectedEvent{},
		})
	}))
	defer cloudServer.Close()

	dataDir := t.TempDir()
	eventStore, err := store.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	eventTime := time.Date(2026, 8, 23, 8, 47, 0, 0, time.UTC)
	event := model.AttendanceEvent{
		DeviceID:   "office-main-01",
		SerialNo:   1,
		EmployeeNo: "17",
		EventTime:  eventTime,
		Major:      5,
		Minor:      75,
		Raw:        []byte(`{"event":"raw"}`),
		ReceivedAt: eventTime,
	}
	event.ID = model.NewEventID(event.DeviceID, event.SerialNo, event.EventTime, event.EmployeeNo, event.Major, event.Minor)
	if _, err := eventStore.PutIfAbsent(event); err != nil {
		t.Fatal(err)
	}
	_ = eventStore.Close()

	cfg := &config.Config{
		Service: config.ServiceConfig{
			PollIntervalSeconds:  1,
			InitialLookbackHours: 1,
			OverlapSeconds:       30,
			SyncIntervalSeconds:  1,
			LocalStatusAddress:   "127.0.0.1:0",
			DataDir:              dataDir,
		},
		Hikvision: config.HikvisionConfig{
			DeviceID:              "office-main-01",
			BaseURL:               deviceServer.URL,
			Username:              "admin",
			Password:              "password",
			PageSize:              30,
			TimeZone:              "UTC",
			RequestTimeoutSeconds: 2,
			RetryCount:            1,
		},
		Cloud: config.CloudConfig{
			Enabled:               true,
			IngestURL:             cloudServer.URL,
			BridgeKey:             "0123456789abcdef0123456789abcdef",
			BatchSize:             1,
			RequestTimeoutSeconds: 5,
			AllowInsecureHTTP:     true,
		},
	}
	runner, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2300*time.Millisecond)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if polls.Load() < 3 {
		t.Fatalf("device polls = %d; slow cloud request appears to have blocked polling", polls.Load())
	}
}

func TestCloudFailureRetainsEventUntilLaterSuccess(t *testing.T) {
	var available atomic.Bool
	cloudServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !available.Load() {
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = response.Write([]byte(`{"error":{"code":"unavailable","message":"try later"}}`))
			return
		}
		var payload struct {
			ProtocolVersion string                  `json:"protocolVersion"`
			RequestID       string                  `json:"requestId"`
			DeviceID        string                  `json:"deviceId"`
			Events          []model.AttendanceEvent `json:"events"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		ids := make([]string, 0, len(payload.Events))
		for _, event := range payload.Events {
			ids = append(ids, event.ID)
		}
		_ = json.NewEncoder(response).Encode(syncer.Response{
			ProtocolVersion: syncer.ProtocolVersion,
			RequestID:       payload.RequestID,
			DeviceID:        payload.DeviceID,
			Accepted:        ids,
			Duplicates:      []string{},
			Rejected:        []syncer.RejectedEvent{},
		})
	}))
	defer cloudServer.Close()

	dataDir := t.TempDir()
	eventStore, err := store.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	eventTime := time.Date(2026, 8, 23, 8, 47, 0, 0, time.UTC)
	event := model.AttendanceEvent{DeviceID: "office-main-01", SerialNo: 2, EmployeeNo: "17", EventTime: eventTime, Major: 5, Minor: 75, ReceivedAt: eventTime}
	event.ID = model.NewEventID(event.DeviceID, event.SerialNo, event.EventTime, event.EmployeeNo, event.Major, event.Minor)
	if _, err := eventStore.PutIfAbsent(event); err != nil {
		t.Fatal(err)
	}
	_ = eventStore.Close()

	cfg := &config.Config{
		Service:   config.ServiceConfig{DataDir: dataDir, LocalStatusAddress: "127.0.0.1:0", SyncedRetentionDays: 90},
		Hikvision: config.HikvisionConfig{DeviceID: "office-main-01", BaseURL: "http://127.0.0.1:1", Username: "admin", Password: "password", TimeZone: "UTC"},
		Cloud:     config.CloudConfig{Enabled: true, IngestURL: cloudServer.URL, BridgeKey: "0123456789abcdef0123456789abcdef", BatchSize: 100, RequestTimeoutSeconds: 2, AllowInsecureHTTP: true},
	}
	runner, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	if _, err := runner.SyncNow(context.Background()); err == nil {
		t.Fatal("expected unavailable cloud error")
	}
	if snapshot := runner.Snapshot(); snapshot.PendingEvents != 1 || snapshot.SyncedEvents != 0 {
		t.Fatalf("event was not retained after cloud failure: %+v", snapshot)
	}
	available.Store(true)
	if count, err := runner.SyncNow(context.Background()); err != nil || count != 1 {
		t.Fatalf("recovery sync count=%d err=%v", count, err)
	}
	if snapshot := runner.Snapshot(); snapshot.PendingEvents != 0 || snapshot.SyncedEvents != 1 {
		t.Fatalf("event did not synchronize after recovery: %+v", snapshot)
	}
}

func TestOfflineDeviceIsReportedToCloudWhileServiceKeepsRunning(t *testing.T) {
	statusSeen := make(chan syncer.BridgeStatus, 1)
	cloudServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			RequestID string               `json:"requestId"`
			DeviceID  string               `json:"deviceId"`
			Probe     bool                 `json:"probe"`
			Status    *syncer.BridgeStatus `json:"status"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if payload.Probe && payload.Status != nil {
			select {
			case statusSeen <- *payload.Status:
			default:
			}
		}
		_ = json.NewEncoder(response).Encode(syncer.Response{
			ProtocolVersion: syncer.ProtocolVersion, RequestID: payload.RequestID,
			DeviceID: payload.DeviceID, OrganizationID: "org-1",
			Accepted: []string{}, Duplicates: []string{}, Rejected: []syncer.RejectedEvent{},
		})
	}))
	defer cloudServer.Close()
	cfg := &config.Config{
		Service: config.ServiceConfig{
			PollIntervalSeconds: 1, InitialLookbackHours: 1, OverlapSeconds: 30,
			SyncIntervalSeconds: 1, StatusIntervalSeconds: 15,
			LocalStatusAddress: "127.0.0.1:0", DataDir: t.TempDir(), SyncedRetentionDays: 90,
		},
		Hikvision: config.HikvisionConfig{
			DeviceID: "office-main-01", BaseURL: "http://127.0.0.1:1", Username: "admin", Password: "wrong-password",
			PageSize: 30, TimeZone: "UTC", RequestTimeoutSeconds: 1,
		},
		Cloud: config.CloudConfig{
			Enabled: true, IngestURL: cloudServer.URL, BridgeKey: "0123456789abcdef0123456789abcdef",
			BatchSize: 100, RequestTimeoutSeconds: 2, AllowInsecureHTTP: true,
		},
	}
	runner, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), "test")
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case status := <-statusSeen:
		if status.DeviceConnected {
			t.Fatalf("offline terminal reported online: %+v", status)
		}
	default:
		t.Fatal("cloud did not receive an offline device status")
	}
}
