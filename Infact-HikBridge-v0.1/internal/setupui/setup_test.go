package setupui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"infactsolutions/hikbridge/internal/config"
	"infactsolutions/hikbridge/internal/winservice"
)

type fakeServiceController struct {
	installed bool
	status    winservice.Status
	actions   []string
}

func (fake *fakeServiceController) Install(_, _, _, _ string) error {
	fake.installed = true
	fake.status = winservice.Status{State: "stopped"}
	fake.actions = append(fake.actions, "install")
	return nil
}

func (fake *fakeServiceController) Uninstall(_ string) error {
	fake.installed = false
	fake.status = winservice.Status{}
	fake.actions = append(fake.actions, "uninstall")
	return nil
}

func (fake *fakeServiceController) Start(_ string) error {
	fake.status = winservice.Status{State: "running", ProcessID: 4242}
	fake.actions = append(fake.actions, "start")
	return nil
}

func (fake *fakeServiceController) Stop(_ string) error {
	fake.status = winservice.Status{State: "stopped"}
	fake.actions = append(fake.actions, "stop")
	return nil
}

func (fake *fakeServiceController) Restart(_ string) error {
	fake.status = winservice.Status{State: "running", ProcessID: 4343}
	fake.actions = append(fake.actions, "restart")
	return nil
}

func (fake *fakeServiceController) QueryStatus(_ string) (winservice.Status, error) {
	if !fake.installed {
		return winservice.Status{}, winservice.ErrNotInstalled
	}
	return fake.status, nil
}

func configuredApplication(t *testing.T) *application {
	t.Helper()
	return &application{
		options: Options{
			ConfigPath: filepath.Join(t.TempDir(), "config.json"), Version: "0.1.0",
			ManageService: true, ServiceName: "InfactHikBridge", ServiceDisplay: "Infact Hikvision Bridge",
		},
		existing: &config.Config{
			Service: config.ServiceConfig{PollIntervalSeconds: 5, DataDir: t.TempDir(), LocalStatusAddress: "127.0.0.1:8765"},
			Hikvision: config.HikvisionConfig{
				DeviceID: "office-main-01", DeviceName: "Main office", BaseURL: "http://192.168.1.64:80",
				Username: "admin", Password: "never-return-device-secret", TimeZone: "Asia/Colombo",
			},
			Cloud: config.CloudConfig{
				Enabled: true, IngestURL: "https://example.test/hikbridgeV1Events",
				BridgeKey: "never-return-bridge-secret-1234567890",
			},
		},
		launchToken: "launch", sessionToken: "session", csrfToken: "csrf", cspNonce: "nonce",
		baseURL: "http://127.0.0.1:8766", shutdown: func() {},
	}
}

func serviceActionRequestForTest(app *application, action string) (*httptest.ResponseRecorder, error) {
	body, err := json.Marshal(map[string]string{"action": action})
	if err != nil {
		return nil, err
	}
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8766/api/service-action", strings.NewReader(string(body)))
	request.RemoteAddr = "127.0.0.1:50000"
	request.AddCookie(&http.Cookie{Name: "hikbridge_setup", Value: "session"})
	request.Header.Set("Origin", app.baseURL)
	request.Header.Set("X-HikBridge-CSRF", "csrf")
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code >= 400 {
		return response, errors.New(response.Body.String())
	}
	return response, nil
}

func TestPublicStateNeverContainsSecrets(t *testing.T) {
	app := configuredApplication(t)
	encoded, err := json.Marshal(app.state())
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if strings.Contains(text, "never-return-device-secret") || strings.Contains(text, "never-return-bridge-secret") {
		t.Fatalf("public setup state leaked a secret: %s", text)
	}
	if !strings.Contains(text, `"hasDevicePassword":true`) || !strings.Contains(text, `"hasBridgeCredential":true`) {
		t.Fatalf("secret presence flags missing: %s", text)
	}
}

func TestBuildConfigKeepsOmittedStoredSecrets(t *testing.T) {
	app := configuredApplication(t)
	value, err := app.buildConfig(setupForm{
		Device:  deviceForm{Address: "10.0.0.20", Port: 443, UseHTTPS: true, Username: "installer", DeviceName: "Reception", TimeZone: "Asia/Colombo"},
		Cloud:   cloudForm{Enabled: true, InstallationCode: "reception-01", IngestURL: "https://example.test/hikbridgeV1Events"},
		Service: serviceForm{PollIntervalSeconds: 10},
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.Hikvision.Password != "never-return-device-secret" || value.Cloud.BridgeKey != "never-return-bridge-secret-1234567890" {
		t.Fatal("omitted secret did not preserve the existing value")
	}
	if value.Hikvision.BaseURL != "https://10.0.0.20:443" || value.Hikvision.DeviceID != "reception-01" {
		t.Fatalf("unexpected configuration: %+v", value.Hikvision)
	}
}

func TestLoopbackAndAPIRequestGuards(t *testing.T) {
	app := configuredApplication(t)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8766/api/state", nil)
	request.RemoteAddr = "192.168.1.20:50000"
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-loopback request status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8766/api/quit", strings.NewReader(`{}`))
	request.RemoteAddr = "127.0.0.1:50000"
	request.AddCookie(&http.Cookie{Name: "hikbridge_setup", Value: "session"})
	request.Header.Set("Origin", "http://malicious.invalid")
	request.Header.Set("X-HikBridge-CSRF", "csrf")
	response = httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin request status=%d", response.Code)
	}
}

func TestServiceLifecycleActions(t *testing.T) {
	app := configuredApplication(t)
	services := &fakeServiceController{}
	app.services = services

	for _, action := range []string{"install", "start", "stop", "uninstall"} {
		response, err := serviceActionRequestForTest(app, action)
		if err != nil {
			t.Fatalf("%s failed: %v", action, err)
		}
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d", action, response.Code)
		}
	}
	if strings.Join(services.actions, ",") != "install,start,stop,uninstall" {
		t.Fatalf("actions = %v", services.actions)
	}
	if services.installed {
		t.Fatal("service remained installed")
	}
}

func TestServiceInstallRequiresSavedConfiguration(t *testing.T) {
	app := configuredApplication(t)
	app.existing = nil
	services := &fakeServiceController{}
	app.services = services

	response, _ := serviceActionRequestForTest(app, "install")
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(services.actions) != 0 {
		t.Fatalf("unexpected service actions: %v", services.actions)
	}
}

func TestServiceStatusReportsRunningProcess(t *testing.T) {
	app := configuredApplication(t)
	app.services = &fakeServiceController{
		installed: true,
		status:    winservice.Status{State: "running", ProcessID: 4242},
	}
	status, err := app.serviceStatus()
	if err != nil {
		t.Fatal(err)
	}
	if !status.Manageable || !status.Configured || !status.Installed || status.State != "running" || status.ProcessID != 4242 {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestSetupPageIncludesServiceControls(t *testing.T) {
	for _, expected := range []string{
		`id="service-install"`,
		`id="service-start"`,
		`id="service-stop"`,
		`id="service-uninstall"`,
		`api("/api/service-action"`,
		`id="uninstall-confirm"`,
	} {
		if !strings.Contains(pageHTML, expected) {
			t.Fatalf("setup page missing %s", expected)
		}
	}
}
