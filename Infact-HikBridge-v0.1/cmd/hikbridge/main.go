package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"infactsolutions/hikbridge/internal/bridge"
	"infactsolutions/hikbridge/internal/config"
	"infactsolutions/hikbridge/internal/elevation"
	"infactsolutions/hikbridge/internal/hikvision"
	"infactsolutions/hikbridge/internal/logging"
	"infactsolutions/hikbridge/internal/setupui"
	"infactsolutions/hikbridge/internal/syncer"
	"infactsolutions/hikbridge/internal/winservice"
)

const (
	serviceName        = "InfactHikBridge"
	displayName        = "Infact Hikvision Bridge"
	serviceDescription = "Bridges Hikvision attendance terminals to Infact cloud services."
)

var version = "dev"
var updateManifestURL = ""
var cloudIngestURL = "https://asia-south1-infact-attendance-128ee.cloudfunctions.net/hikbridgeV1Events"
var cloudRealtimeSessionURL = "https://asia-south1-infact-attendance-128ee.cloudfunctions.net/hikbridgeV1Session"

func usage() {
	fmt.Fprintf(os.Stderr, `Infact HikBridge %s

Usage:
  hikbridge.exe test-device [--config PATH]
  hikbridge.exe test-users [--config PATH]
  hikbridge.exe test-events [--config PATH] [--minutes 10] [--raw]
  hikbridge.exe test-cloud [--config PATH]
  hikbridge.exe sync-now [--config PATH]
  hikbridge.exe setup [--config PATH] [--listen 127.0.0.1:8766] [--no-open]
  hikbridge.exe run [--config PATH]
  hikbridge.exe install [--config PATH]
  hikbridge.exe uninstall
  hikbridge.exe start
  hikbridge.exe stop
  hikbridge.exe restart
  hikbridge.exe status
  hikbridge.exe version

Local diagnostics while running:
  http://127.0.0.1:8765/health
  http://127.0.0.1:8765/status
`, version)
}

func parseConfigFlag(command string, args []string) (string, error) {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	path := flags.String("config", config.DefaultPath(), "config file")
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	if flags.NArg() != 0 {
		return "", fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	return *path, nil
}

func serviceConfigPath(args []string) (string, error) {
	if len(args) > 0 && args[0] == "run" {
		args = args[1:]
	}
	return parseConfigFlag("run", args)
}

func loadConfig(path string) (*config.Config, error) {
	cfg, err := config.LoadWithCloudEndpoints(path, config.CloudEndpoints{
		IngestURL:          cloudIngestURL,
		RealtimeSessionURL: cloudRealtimeSessionURL,
	})
	if err != nil {
		return nil, fmt.Errorf("load config %s: %w", path, err)
	}
	normalized, err := hikvision.NormalizeBaseURL(cfg.Hikvision.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("normalize Hikvision base URL: %w", err)
	}
	cfg.Hikvision.BaseURL = normalized
	return cfg, nil
}

func newDeviceClient(cfg *config.Config) (*hikvision.Client, error) {
	location, err := cfg.DeviceLocation()
	if err != nil {
		return nil, err
	}
	return hikvision.New(hikvision.Options{
		BaseURL:    cfg.Hikvision.BaseURL,
		DeviceID:   cfg.Hikvision.DeviceID,
		Username:   cfg.Hikvision.Username,
		Password:   cfg.Hikvision.Password,
		PageSize:   cfg.Hikvision.PageSize,
		Location:   location,
		Timeout:    time.Duration(cfg.Hikvision.RequestTimeoutSeconds) * time.Second,
		RetryCount: cfg.Hikvision.RetryCount,
	}), nil
}

func newCloudClient(cfg *config.Config) (*syncer.Client, error) {
	if !cfg.Cloud.Enabled {
		return nil, errors.New("cloud sync is disabled in config")
	}
	return syncer.New(syncer.Options{
		URL:               cfg.Cloud.IngestURL,
		DeviceID:          cfg.Hikvision.DeviceID,
		BridgeKey:         cfg.Cloud.BridgeKey,
		Timeout:           time.Duration(cfg.Cloud.RequestTimeoutSeconds) * time.Second,
		AllowInsecureHTTP: cfg.Cloud.AllowInsecureHTTP,
		AgentVersion:      version,
	})
}

func makeLogger(cfg *config.Config, interactive bool) (*slog.Logger, io.Closer, error) {
	logPath := filepath.Join(cfg.Service.DataDir, "logs", "hikbridge.log")
	file, err := logging.Open(logPath, int64(cfg.Service.LogMaxMegabytes)<<20, cfg.Service.LogBackups)
	if err != nil {
		return nil, nil, err
	}
	var writer io.Writer = file
	if interactive {
		writer = io.MultiWriter(file, os.Stdout)
	}
	handler := slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(handler), file, nil
}

func runBridge(ctx context.Context, configPath string, interactive bool) error {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	logger, closer, err := makeLogger(cfg, interactive)
	if err != nil {
		return fmt.Errorf("open service log: %w", err)
	}
	defer closer.Close()
	logger.Info("bridge_starting", "device", cfg.Hikvision.DeviceID, "version", version)
	runner, err := bridge.New(cfg, logger, version)
	if err != nil {
		return err
	}
	defer runner.Close()
	if err := runner.Run(ctx); err != nil {
		logger.Error("bridge_stopped_with_error", "error", err)
		return err
	}
	logger.Info("bridge_stopped")
	return nil
}

func testDevice(args []string) error {
	configPath, err := parseConfigFlag("test-device", args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	client, err := newDeviceClient(cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	info, err := client.DeviceInfo(ctx)
	if err != nil {
		return fmt.Errorf("device connection failed: %w", err)
	}
	fmt.Println("Device connected successfully")
	fmt.Println("Endpoint:", cfg.Hikvision.BaseURL)
	fmt.Println("Model:", valueOrUnknown(info.Model))
	fmt.Println("Serial:", valueOrUnknown(info.SerialNumber))
	fmt.Println("Firmware:", valueOrUnknown(info.FirmwareVersion))
	deviceTime, err := client.DeviceTime(ctx)
	if err != nil {
		fmt.Println("Device time: unavailable (", err, ")")
		return nil
	}
	fmt.Println("Device time:", deviceTime.LocalTime)
	fmt.Println("Device timezone:", valueOrUnknown(deviceTime.TimeZone))
	fmt.Println("Time mode:", valueOrUnknown(deviceTime.TimeMode))
	return nil
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "not reported"
	}
	return value
}

func testUsers(args []string) error {
	configPath, err := parseConfigFlag("test-users", args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	client, err := newDeviceClient(cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	users, err := client.SearchUsers(ctx)
	if err != nil {
		return fmt.Errorf("user search failed: %w", err)
	}
	fmt.Printf("Found %d users\n", len(users))
	for _, user := range users {
		fingerprint := "not reported"
		if user.FingerprintCount != nil {
			fingerprint = fmt.Sprintf("%d enrolled", *user.FingerprintCount)
		}
		fmt.Println("---")
		fmt.Println("Employee No:", valueOrUnknown(user.EmployeeNo))
		fmt.Println("Name:", valueOrUnknown(user.Name))
		fmt.Println("Card No:", valueOrUnknown(user.CardNo))
		fmt.Println("Fingerprint:", fingerprint)
	}
	return nil
}

func testEvents(args []string) error {
	flags := flag.NewFlagSet("test-events", flag.ContinueOnError)
	configPath := flags.String("config", config.DefaultPath(), "config file")
	minutes := flags.Int("minutes", 10, "how many minutes back to search")
	raw := flags.Bool("raw", false, "display original Hikvision response JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if *minutes < 1 || *minutes > 60*24*31 {
		return errors.New("--minutes must be between 1 and 44640")
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	client, err := newDeviceClient(cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	end := time.Now()
	result, err := client.SearchEventsDetailed(ctx, end.Add(-time.Duration(*minutes)*time.Minute), end)
	if err != nil {
		return fmt.Errorf("event search failed: %w", err)
	}
	fmt.Printf("Found %d events\n", len(result.Events))
	for _, event := range result.Events {
		fmt.Println("---")
		fmt.Println("Timestamp:", event.EventTime.Format(time.RFC3339))
		fmt.Println("Employee No:", valueOrUnknown(event.EmployeeNo))
		fmt.Println("Employee Name:", valueOrUnknown(event.Name))
		fmt.Println("Event Serial:", event.SerialNo)
		fmt.Println("Major:", event.Major)
		fmt.Println("Minor:", event.Minor)
		fmt.Println("Attendance Status:", valueOrUnknown(event.AttendanceStatus))
		fmt.Println("Verification Mode:", valueOrUnknown(event.CurrentVerifyMode))
		fmt.Println("Device:", event.DeviceID)
	}
	if *raw {
		for index, page := range result.RawPages {
			fmt.Printf("--- RAW PAGE %d ---\n", index+1)
			var formatted bytes.Buffer
			if err := json.Indent(&formatted, page, "", "  "); err != nil {
				fmt.Println(string(page))
			} else {
				fmt.Println(formatted.String())
			}
		}
	}
	if len(result.Issues) > 0 {
		for _, issue := range result.Issues {
			fmt.Fprintf(os.Stderr, "Malformed event page=%d index=%d: %s\n", issue.Page, issue.Index, issue.Message)
		}
		return fmt.Errorf("device returned %d malformed events; raw payloads were displayed only when --raw was set", len(result.Issues))
	}
	return nil
}

func testCloud(args []string) error {
	configPath, err := parseConfigFlag("test-cloud", args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	client, err := newCloudClient(cfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := client.Probe(ctx)
	if err != nil {
		return fmt.Errorf("cloud test failed: %w", err)
	}
	fmt.Println("Cloud connection successful")
	fmt.Println("Device:", result.DeviceID)
	fmt.Println("Organization:", result.OrganizationID)
	fmt.Println("Branch:", valueOrUnknown(result.BranchID))
	return nil
}

func syncNow(args []string) error {
	configPath, err := parseConfigFlag("sync-now", args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	if !cfg.Cloud.Enabled {
		return errors.New("cloud sync is disabled in config")
	}
	logger, closer, err := makeLogger(cfg, true)
	if err != nil {
		return err
	}
	defer closer.Close()
	runner, err := bridge.New(cfg, logger, version)
	if err != nil {
		return err
	}
	defer runner.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	count, err := runner.SyncNow(ctx)
	if err != nil {
		return fmt.Errorf("sync failed after processing %d events: %w", count, err)
	}
	fmt.Printf("Cloud synchronization complete. Processed %d events.\n", count)
	return nil
}

func install(args []string) error {
	configPath, err := parseConfigFlag("install", args)
	if err != nil {
		return err
	}
	if _, err := loadConfig(configPath); err != nil {
		return err
	}
	if err := winservice.Install(serviceName, displayName, serviceDescription, configPath); err != nil {
		return err
	}
	fmt.Println("Windows service installed:", displayName)
	return nil
}

func runSetup(args []string) error {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	configPath := flags.String("config", config.DefaultPath(), "config file")
	listenAddress := flags.String("listen", "127.0.0.1:8766", "loopback setup address")
	noOpen := flags.Bool("no-open", false, "do not open the browser automatically")
	noService := flags.Bool("no-service", false, "save configuration without managing the Windows service")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	manageService := runtime.GOOS == "windows" && !*noService
	if manageService && !elevation.IsElevated() {
		return elevation.Relaunch(append([]string{"setup"}, args...))
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return setupui.Run(ctx, setupui.Options{
		ConfigPath:         *configPath,
		ListenAddress:      *listenAddress,
		Version:            version,
		UpdateManifestURL:  updateManifestURL,
		CloudIngestURL:     cloudIngestURL,
		RealtimeSessionURL: cloudRealtimeSessionURL,
		OpenBrowser:        !*noOpen,
		ManageService:      manageService,
		ServiceName:        serviceName,
		ServiceDisplay:     displayName,
		ServiceDescription: serviceDescription,
	})
}

func runInteractive(args []string) error {
	configPath, err := parseConfigFlag("run", args)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return runBridge(ctx, configPath, true)
}

func runCommand(command string, args []string) error {
	switch command {
	case "run":
		return runInteractive(args)
	case "test-device":
		return testDevice(args)
	case "test-users":
		return testUsers(args)
	case "test-events":
		return testEvents(args)
	case "test-cloud":
		return testCloud(args)
	case "sync-now":
		return syncNow(args)
	case "setup":
		return runSetup(args)
	case "install":
		return install(args)
	case "uninstall":
		if len(args) != 0 {
			return errors.New("uninstall does not accept arguments")
		}
		if err := winservice.Uninstall(serviceName); err != nil {
			if errors.Is(err, winservice.ErrNotInstalled) {
				fmt.Println("Windows service is already removed:", displayName)
				return nil
			}
			return err
		}
		fmt.Println("Windows service removed:", displayName)
		return nil
	case "start":
		if err := winservice.Start(serviceName); err != nil {
			return err
		}
		fmt.Println("Windows service started:", displayName)
		return nil
	case "stop":
		if err := winservice.Stop(serviceName); err != nil {
			return err
		}
		fmt.Println("Windows service stopped:", displayName)
		return nil
	case "restart":
		if err := winservice.Restart(serviceName); err != nil {
			return err
		}
		fmt.Println("Windows service restarted:", displayName)
		return nil
	case "status":
		status, err := winservice.QueryStatus(serviceName)
		if err != nil {
			return err
		}
		fmt.Println("State:", status.State)
		fmt.Println("Process ID:", status.ProcessID)
		fmt.Println("Exit code:", status.ExitCode)
		return nil
	case "version":
		fmt.Println(version)
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func main() {
	if winservice.IsWindowsService() {
		configPath, err := serviceConfigPath(os.Args[1:])
		if err != nil {
			os.Exit(1)
		}
		if err := winservice.Run(serviceName, func(ctx context.Context) error {
			return runBridge(ctx, configPath, false)
		}); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	if err := runCommand(os.Args[1], os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
