package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	_ "time/tzdata"

	"infactsolutions/hikbridge/internal/atomicfile"
)

type Config struct {
	Service   ServiceConfig   `json:"service"`
	Hikvision HikvisionConfig `json:"hikvision"`
	Cloud     CloudConfig     `json:"cloud"`
}

type ServiceConfig struct {
	PollIntervalSeconds   int    `json:"pollIntervalSeconds"`
	InitialLookbackHours  int    `json:"initialLookbackHours"`
	OverlapSeconds        int    `json:"overlapSeconds"`
	SyncIntervalSeconds   int    `json:"syncIntervalSeconds"`
	StatusIntervalSeconds int    `json:"statusIntervalSeconds"`
	LocalStatusAddress    string `json:"localStatusAddress"`
	DataDir               string `json:"dataDir"`
	LogMaxMegabytes       int    `json:"logMaxMegabytes"`
	LogBackups            int    `json:"logBackups"`
	SyncedRetentionDays   int    `json:"syncedRetentionDays"`
}

type HikvisionConfig struct {
	DeviceID              string `json:"deviceId"`
	DeviceName            string `json:"deviceName,omitempty"`
	BaseURL               string `json:"baseUrl"`
	Username              string `json:"username"`
	Password              string `json:"password"`
	PageSize              int    `json:"pageSize"`
	TimeZone              string `json:"timeZone"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	RetryCount            int    `json:"retryCount"`
}

type CloudConfig struct {
	Enabled               bool   `json:"enabled"`
	IngestURL             string `json:"ingestUrl"`
	BridgeKey             string `json:"bridgeKey"`
	BatchSize             int    `json:"batchSize"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	AllowInsecureHTTP     bool   `json:"allowInsecureHttp"`
}

var deviceIDRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func DefaultPath() string {
	if runtime.GOOS == "windows" {
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "Infact", "HikBridge", "config.json")
	}
	return "./config.json"
}

func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 1<<20))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	config.applyDefaults()
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

// Save validates and atomically replaces a configuration file. The restrictive
// mode is meaningful on Unix; on Windows the installer/setup ACL on the parent
// directory provides the access boundary.
func Save(path string, value *Config) error {
	if value == nil {
		return errors.New("config is required")
	}
	value.applyDefaults()
	if err := value.Validate(); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	encoded = append(encoded, '\n')
	if err := atomicfile.WriteFile(path, encoded, 0600); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	return nil
}

// ApplyDefaults fills optional operational values while retaining required
// device and cloud fields for the caller to supply.
func (c *Config) ApplyDefaults() { c.applyDefaults() }

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode trailing config data: %w", err)
	}
	return errors.New("config contains multiple JSON values")
}

func (c *Config) applyDefaults() {
	if c.Service.PollIntervalSeconds == 0 {
		c.Service.PollIntervalSeconds = 5
	}
	if c.Service.InitialLookbackHours == 0 {
		c.Service.InitialLookbackHours = 24
	}
	if c.Service.OverlapSeconds == 0 {
		c.Service.OverlapSeconds = 120
	}
	if c.Service.SyncIntervalSeconds == 0 {
		c.Service.SyncIntervalSeconds = 5
	}
	if c.Service.StatusIntervalSeconds == 0 {
		c.Service.StatusIntervalSeconds = 60
	}
	if c.Service.LocalStatusAddress == "" {
		c.Service.LocalStatusAddress = "127.0.0.1:8765"
	}
	if c.Service.DataDir == "" {
		if runtime.GOOS == "windows" {
			base := os.Getenv("ProgramData")
			if base == "" {
				base = `C:\ProgramData`
			}
			c.Service.DataDir = filepath.Join(base, "Infact", "HikBridge")
		} else {
			c.Service.DataDir = "./data"
		}
	}
	if c.Service.LogMaxMegabytes == 0 {
		c.Service.LogMaxMegabytes = 20
	}
	if c.Service.LogBackups == 0 {
		c.Service.LogBackups = 5
	}
	if c.Service.SyncedRetentionDays == 0 {
		c.Service.SyncedRetentionDays = 90
	}
	if c.Hikvision.PageSize == 0 {
		c.Hikvision.PageSize = 30
	}
	if c.Hikvision.TimeZone == "" {
		c.Hikvision.TimeZone = "Local"
	}
	if c.Hikvision.RequestTimeoutSeconds == 0 {
		c.Hikvision.RequestTimeoutSeconds = 12
	}
	if c.Hikvision.RetryCount == 0 {
		c.Hikvision.RetryCount = 2
	}
	if c.Cloud.BatchSize == 0 {
		c.Cloud.BatchSize = 100
	}
	if c.Cloud.RequestTimeoutSeconds == 0 {
		c.Cloud.RequestTimeoutSeconds = 15
	}
}

func (c *Config) Validate() error {
	if !deviceIDRE.MatchString(c.Hikvision.DeviceID) {
		return errors.New("hikvision.deviceId must be 1-64 letters, digits, dots, underscores, or hyphens")
	}
	if len(strings.TrimSpace(c.Hikvision.DeviceName)) > 120 {
		return errors.New("hikvision.deviceName must not exceed 120 characters")
	}
	if err := validateHikvisionURL(c.Hikvision.BaseURL); err != nil {
		return fmt.Errorf("hikvision.baseUrl: %w", err)
	}
	if strings.TrimSpace(c.Hikvision.Username) == "" || c.Hikvision.Password == "" {
		return errors.New("hikvision.username and hikvision.password are required")
	}
	if strings.ContainsAny(c.Hikvision.Username, "\r\n") {
		return errors.New("hikvision.username contains invalid control characters")
	}
	if _, err := c.DeviceLocation(); err != nil {
		return fmt.Errorf("hikvision.timeZone: %w", err)
	}
	if c.Hikvision.PageSize < 1 || c.Hikvision.PageSize > 30 {
		return errors.New("hikvision.pageSize must be between 1 and 30")
	}
	if c.Hikvision.RequestTimeoutSeconds < 1 || c.Hikvision.RequestTimeoutSeconds > 120 {
		return errors.New("hikvision.requestTimeoutSeconds must be between 1 and 120")
	}
	if c.Hikvision.RetryCount < 0 || c.Hikvision.RetryCount > 5 {
		return errors.New("hikvision.retryCount must be between 0 and 5")
	}
	if c.Service.PollIntervalSeconds < 1 || c.Service.PollIntervalSeconds > 3600 {
		return errors.New("service.pollIntervalSeconds must be between 1 and 3600")
	}
	if c.Service.InitialLookbackHours < 1 || c.Service.InitialLookbackHours > 24*31 {
		return errors.New("service.initialLookbackHours must be between 1 and 744")
	}
	if c.Service.OverlapSeconds < 1 || c.Service.OverlapSeconds > 3600 {
		return errors.New("service.overlapSeconds must be between 1 and 3600")
	}
	if c.Service.SyncIntervalSeconds < 1 || c.Service.SyncIntervalSeconds > 3600 {
		return errors.New("service.syncIntervalSeconds must be between 1 and 3600")
	}
	if c.Service.StatusIntervalSeconds < 15 || c.Service.StatusIntervalSeconds > 3600 {
		return errors.New("service.statusIntervalSeconds must be between 15 and 3600")
	}
	if strings.TrimSpace(c.Service.DataDir) == "" {
		return errors.New("service.dataDir is required")
	}
	if c.Service.LogMaxMegabytes < 1 || c.Service.LogMaxMegabytes > 1024 {
		return errors.New("service.logMaxMegabytes must be between 1 and 1024")
	}
	if c.Service.LogBackups < 1 || c.Service.LogBackups > 50 {
		return errors.New("service.logBackups must be between 1 and 50")
	}
	if c.Service.SyncedRetentionDays < 1 || c.Service.SyncedRetentionDays > 3650 {
		return errors.New("service.syncedRetentionDays must be between 1 and 3650")
	}
	if err := validateLoopbackAddress(c.Service.LocalStatusAddress); err != nil {
		return fmt.Errorf("service.localStatusAddress: %w", err)
	}
	if c.Cloud.Enabled {
		if strings.TrimSpace(c.Cloud.IngestURL) == "" {
			return errors.New("cloud.ingestUrl is required when cloud.enabled=true")
		}
		if len(c.Cloud.BridgeKey) < 32 {
			return errors.New("cloud.bridgeKey must contain at least 32 characters when cloud.enabled=true")
		}
		if err := validateCloudURL(c.Cloud.IngestURL, c.Cloud.AllowInsecureHTTP); err != nil {
			return fmt.Errorf("cloud.ingestUrl: %w", err)
		}
	}
	if c.Cloud.BatchSize < 1 || c.Cloud.BatchSize > 100 {
		return errors.New("cloud.batchSize must be between 1 and 100")
	}
	if c.Cloud.RequestTimeoutSeconds < 1 || c.Cloud.RequestTimeoutSeconds > 120 {
		return errors.New("cloud.requestTimeoutSeconds must be between 1 and 120")
	}
	return nil
}

func (c *Config) DeviceLocation() (*time.Location, error) {
	if strings.EqualFold(c.Hikvision.TimeZone, "Local") {
		return time.Local, nil
	}
	return time.LoadLocation(c.Hikvision.TimeZone)
}

func validateHikvisionURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("scheme must be http or https")
	}
	if parsed.Host == "" {
		return errors.New("host is required")
	}
	if parsed.User != nil {
		return errors.New("credentials must not be included in the URL")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("query and fragment are not allowed")
	}
	return nil
}

func validateCloudURL(raw string, allowInsecure bool) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if parsed.Host == "" || parsed.User != nil {
		return errors.New("host is required and URL credentials are forbidden")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme != "http" || !allowInsecure || !isLoopbackHost(parsed.Hostname()) {
		return errors.New("HTTPS is required; HTTP is allowed only for loopback with allowInsecureHttp=true")
	}
	return nil
}

func validateLoopbackAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("must be a host:port address")
	}
	if port == "" {
		return errors.New("port is required")
	}
	if !isLoopbackHost(host) {
		return errors.New("must bind to localhost or a loopback IP")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
