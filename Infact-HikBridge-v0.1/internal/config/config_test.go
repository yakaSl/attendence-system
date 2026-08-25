package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func validConfig() Config {
	return Config{
		Service: ServiceConfig{
			LocalStatusAddress: "127.0.0.1:8765",
			DataDir:            "./data",
		},
		Hikvision: HikvisionConfig{
			DeviceID: "office-main-01",
			BaseURL:  "http://192.168.1.64",
			Username: "admin",
			Password: "device-password",
			TimeZone: "Asia/Colombo",
		},
		Cloud: CloudConfig{Enabled: false},
	}
}

func writeConfig(t *testing.T, contents []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, contents, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadAppliesDefaultsAndLoadsIANAZone(t *testing.T) {
	contents, _ := json.Marshal(validConfig())
	config, err := Load(writeConfig(t, contents))
	if err != nil {
		t.Fatal(err)
	}
	if config.Service.PollIntervalSeconds != 5 || config.Service.StatusIntervalSeconds != 240 || config.Hikvision.PageSize != 30 || config.Cloud.BatchSize != 100 {
		t.Fatalf("defaults not applied: %+v", config)
	}
	location, err := config.DeviceLocation()
	if err != nil || location.String() != "Asia/Colombo" {
		t.Fatalf("location=%v err=%v", location, err)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	raw := []byte(`{
      "service":{"localStatusAddress":"127.0.0.1:8765","dataDir":"./data","pollIntervlSeconds":5},
      "hikvision":{"deviceId":"device-1","baseUrl":"http://192.168.1.64","username":"admin","password":"secret","timeZone":"Asia/Colombo"},
      "cloud":{"enabled":false}
    }`)
	_, err := Load(writeConfig(t, raw))
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown-field error, got %v", err)
	}
}

func TestValidateRejectsPublicDiagnosticsBind(t *testing.T) {
	config := validConfig()
	config.applyDefaults()
	config.Service.LocalStatusAddress = "0.0.0.0:8765"
	err := config.Validate()
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("expected loopback error, got %v", err)
	}
}

func TestValidateCloudTransportAndSecret(t *testing.T) {
	config := validConfig()
	config.applyDefaults()
	config.Cloud.Enabled = true
	config.Cloud.IngestURL = "http://example.com/hikbridge/v1/events"
	config.Cloud.BridgeKey = "short"
	err := config.Validate()
	if err == nil || !strings.Contains(err.Error(), "at least 32") {
		t.Fatalf("expected bridge-key error, got %v", err)
	}
	config.Cloud.BridgeKey = "0123456789abcdef0123456789abcdef"
	err = config.Validate()
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected HTTPS error, got %v", err)
	}
	config.Cloud.IngestURL = "http://127.0.0.1:5001/hikbridge/v1/events"
	config.Cloud.AllowInsecureHTTP = true
	if err := config.Validate(); err != nil {
		t.Fatalf("explicit loopback development transport rejected: %v", err)
	}
}

func TestSaveRoundTripsAndUsesRestrictiveMode(t *testing.T) {
	value := validConfig()
	path := filepath.Join(t.TempDir(), "nested", "config.json")
	if err := Save(path, &value); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Hikvision.Password != "device-password" || loaded.Service.PollIntervalSeconds != 5 {
		t.Fatalf("unexpected round trip: %+v", loaded)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Fatalf("config mode is too broad: %v", info.Mode().Perm())
	}
}
