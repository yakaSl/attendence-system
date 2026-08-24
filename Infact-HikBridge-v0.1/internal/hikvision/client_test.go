package hikvision

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func testClient(server *httptest.Server, location *time.Location) *Client {
	return New(Options{
		BaseURL:    server.URL,
		DeviceID:   "office-main-01",
		Username:   "admin",
		Password:   "test-password",
		PageSize:   1,
		Location:   location,
		RetryCount: 0,
		HTTPClient: server.Client(),
	})
}

func eventResponse(t *testing.T, request *http.Request, body string) string {
	t.Helper()
	var payload struct {
		Condition struct {
			SearchID string `json:"searchID"`
		} `json:"AcsEventCond"`
	}
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return strings.ReplaceAll(body, "{{SEARCH_ID}}", payload.Condition.SearchID)
}

func TestSearchIDsStayWithinLegacyFirmwareLimit(t *testing.T) {
	for _, prefix := range []string{"u", "e"} {
		searchID := newSearchID(prefix)
		if !strings.HasPrefix(searchID, prefix) || len(searchID) > 16 {
			t.Fatalf("search ID %q is not a short prefixed identifier", searchID)
		}
	}
}

func TestSearchEventsPaginationAndRawPreservation(t *testing.T) {
	pageOne := fixture(t, "events_page_1.json")
	pageTwo := fixture(t, "events_page_2.json")
	var mu sync.Mutex
	positions := []int{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Condition struct {
				SearchID string `json:"searchID"`
				Position int    `json:"searchResultPosition"`
			} `json:"AcsEventCond"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		positions = append(positions, payload.Condition.Position)
		mu.Unlock()
		body := pageOne
		if payload.Condition.Position == 1 {
			body = pageTwo
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(strings.ReplaceAll(body, "{{SEARCH_ID}}", payload.Condition.SearchID)))
	}))
	defer server.Close()

	client := testClient(server, time.FixedZone("Asia/Colombo", 5*60*60+30*60))
	result, err := client.SearchEventsDetailed(
		context.Background(),
		time.Date(2026, 8, 23, 8, 0, 0, 0, time.Local),
		time.Date(2026, 8, 23, 18, 0, 0, 0, time.Local),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 2 || len(result.RawPages) != 2 || len(result.Issues) != 0 {
		t.Fatalf("unexpected result sizes: events=%d pages=%d issues=%d", len(result.Events), len(result.RawPages), len(result.Issues))
	}
	if !reflect.DeepEqual(positions, []int{0, 1}) {
		t.Fatalf("pagination positions = %v", positions)
	}
	if result.Events[0].EmployeeNo != "17" || result.Events[0].SerialNo != 4101 {
		t.Fatalf("unexpected normalized event: %+v", result.Events[0])
	}
	if !strings.Contains(string(result.Events[0].Raw), "futureFirmwareField") {
		t.Fatal("unknown firmware field was not preserved")
	}
	if result.Events[0].ID == result.Events[1].ID {
		t.Fatal("distinct physical events received the same deterministic ID")
	}
}

func TestSearchEventsAllowsMissingOptionalFieldsAndUsesConfiguredTimezone(t *testing.T) {
	body := fixture(t, "events_missing_fields.json")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(eventResponse(t, request, body)))
	}))
	defer server.Close()
	location := time.FixedZone("Asia/Colombo", 5*60*60+30*60)
	result, err := testClient(server, location).SearchEventsDetailed(context.Background(), time.Now().Add(-time.Hour), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 1 || len(result.Issues) != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	event := result.Events[0]
	_, offset := event.EventTime.Zone()
	if offset != 5*60*60+30*60 {
		t.Fatalf("offset = %d", offset)
	}
	if event.Name != "" || event.CardNo != "" {
		t.Fatal("missing optional fields were fabricated")
	}
	if !strings.Contains(string(event.Raw), "unknownScalar") {
		t.Fatal("unknown field was not preserved")
	}
}

func TestSearchEventsReturnsMalformedTimestampAsPreservableIssue(t *testing.T) {
	body := fixture(t, "events_malformed_timestamp.json")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(eventResponse(t, request, body)))
	}))
	defer server.Close()
	result, err := testClient(server, time.UTC).SearchEventsDetailed(context.Background(), time.Now().Add(-time.Hour), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 0 || len(result.Issues) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if !strings.Contains(string(result.Issues[0].Raw), "must survive") {
		t.Fatal("malformed event raw evidence was not retained")
	}
}

func TestSearchEventsRejectsZeroProgressPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Condition struct {
				SearchID string `json:"searchID"`
			} `json:"AcsEventCond"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		_, _ = response.Write([]byte(`{"AcsEvent":{"searchID":"` + payload.Condition.SearchID + `","totalMatches":2,"responseStatusStrg":"MORE","numOfMatches":0,"InfoList":[]}}`))
	}))
	defer server.Close()
	_, err := testClient(server, time.UTC).SearchEventsDetailed(context.Background(), time.Now().Add(-time.Hour), time.Now())
	if err == nil || !strings.Contains(err.Error(), "zero progress") {
		t.Fatalf("expected zero-progress error, got %v", err)
	}
}

func TestParseDeviceInfoJSONAndXML(t *testing.T) {
	jsonInfo, err := parseDeviceInfo([]byte(fixture(t, "device_info.json")))
	if err != nil {
		t.Fatal(err)
	}
	if jsonInfo.Model != "DS-K1A8503EF" || jsonInfo.SerialNumber == "" {
		t.Fatalf("unexpected JSON info: %+v", jsonInfo)
	}
	xmlInfo, err := parseDeviceInfo([]byte(`<DeviceInfo><deviceName>Main</deviceName><model>DS-K1A8503EF</model><serialNumber>ABC</serialNumber><firmwareVersion>V1</firmwareVersion></DeviceInfo>`))
	if err != nil {
		t.Fatal(err)
	}
	if xmlInfo.SerialNumber != "ABC" || xmlInfo.FirmwareVersion != "V1" {
		t.Fatalf("unexpected XML info: %+v", xmlInfo)
	}
}

func TestSearchUsersToleratesFirmwareSpecificMissingFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var payload struct {
			Condition struct {
				SearchID string `json:"searchID"`
				Position int    `json:"searchResultPosition"`
			} `json:"UserInfoSearchCond"`
		}
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if payload.Condition.Position == 0 {
			_, _ = response.Write([]byte(`{"UserInfoSearch":{"searchID":"` + payload.Condition.SearchID + `","totalMatches":2,"responseStatusStrg":"MORE","numOfMatches":1,"UserInfo":[{"employeeNo":"17","name":"Kasun","numOfFP":2,"CardInfo":[{"cardNo":"10017"}],"unknown":"preserved"}]}}`))
			return
		}
		_, _ = response.Write([]byte(`{"UserInfoSearch":{"searchID":"` + payload.Condition.SearchID + `","totalMatches":2,"responseStatusStrg":"OK","numOfMatches":1,"UserInfo":[{"employeeNo":"18","name":"Nimali"}]}}`))
	}))
	defer server.Close()
	users, err := testClient(server, time.UTC).SearchUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 || users[0].FingerprintCount == nil || *users[0].FingerprintCount != 2 {
		t.Fatalf("unexpected users: %+v", users)
	}
	if users[1].FingerprintCount != nil || users[1].CardNo != "" {
		t.Fatalf("missing firmware fields were fabricated: %+v", users[1])
	}
}

func TestTemporaryHTTPFailureIsRetriedWithinBound(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if calls.Add(1) == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = response.Write([]byte(fixture(t, "device_info.json")))
	}))
	defer server.Close()
	client := New(Options{
		BaseURL:    server.URL,
		DeviceID:   "device-1",
		Username:   "admin",
		Password:   "secret",
		RetryCount: 1,
		HTTPClient: server.Client(),
	})
	if _, err := client.DeviceInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d", calls.Load())
	}
}
