package bridge

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"infactsolutions/hikbridge/internal/config"
	"infactsolutions/hikbridge/internal/hikvision"
	"infactsolutions/hikbridge/internal/model"
	bridgerealtime "infactsolutions/hikbridge/internal/realtime"
	"infactsolutions/hikbridge/internal/store"
	"infactsolutions/hikbridge/internal/syncer"
)

type Status struct {
	StartedAt                time.Time `json:"startedAt"`
	UptimeSeconds            int64     `json:"uptimeSeconds"`
	BridgeVersion            string    `json:"bridgeVersion"`
	DeviceConnected          bool      `json:"deviceConnected"`
	DeviceModel              string    `json:"deviceModel,omitempty"`
	DeviceSerial             string    `json:"deviceSerial,omitempty"`
	FirmwareVersion          string    `json:"firmwareVersion,omitempty"`
	LastDevicePoll           time.Time `json:"lastDevicePoll,omitempty"`
	LastSuccessfulDevicePoll time.Time `json:"lastSuccessfulDevicePoll,omitempty"`
	LastDeviceError          string    `json:"lastDeviceError,omitempty"`
	PendingEvents            int       `json:"pendingEvents"`
	UploadingEvents          int       `json:"uploadingEvents"`
	SyncedEvents             int       `json:"syncedEvents"`
	FailedEvents             int       `json:"failedEvents"`
	EventsRetrieved          int64     `json:"eventsRetrieved"`
	EventsQueued             int64     `json:"eventsQueued"`
	EventsSynced             int64     `json:"eventsSynced"`
	CloudFailures            int64     `json:"cloudFailures"`
	LastCloudSync            time.Time `json:"lastCloudSync,omitempty"`
	LastCloudError           string    `json:"lastCloudError,omitempty"`
	LastStorageError         string    `json:"lastStorageError,omitempty"`
	LastCommandPoll          time.Time `json:"lastCommandPoll,omitempty"`
	LastCommandError         string    `json:"lastCommandError,omitempty"`
	ActiveCommandID          string    `json:"activeCommandId,omitempty"`
	ActiveCommandType        string    `json:"activeCommandType,omitempty"`
	PendingCommandResults    int       `json:"pendingCommandResults"`
	CommandsReceived         int64     `json:"commandsReceived"`
	CommandsSucceeded        int64     `json:"commandsSucceeded"`
	CommandsFailed           int64     `json:"commandsFailed"`
	RealtimeConnected        bool      `json:"realtimeConnected"`
	LastRealtimeConnect      time.Time `json:"lastRealtimeConnect,omitempty"`
	LastRealtimeError        string    `json:"lastRealtimeError,omitempty"`
}

type realtimeCommandClient interface {
	Run(context.Context, func(), func(bool), func(error))
}

type Runner struct {
	cfg      *config.Config
	log      *slog.Logger
	device   *hikvision.Client
	store    *store.Store
	cloud    *syncer.Client
	realtime realtimeCommandClient
	version  string

	mu          sync.RWMutex
	deviceMu    sync.Mutex
	status      Status
	running     atomic.Bool
	syncWake    chan struct{}
	commandWake chan struct{}
}

func New(cfg *config.Config, logger *slog.Logger, version string) (*Runner, error) {
	eventStore, err := store.Open(cfg.Service.DataDir)
	if err != nil {
		return nil, err
	}
	location, err := cfg.DeviceLocation()
	if err != nil {
		eventStore.Close()
		return nil, err
	}
	device := hikvision.New(hikvision.Options{
		BaseURL:    cfg.Hikvision.BaseURL,
		DeviceID:   cfg.Hikvision.DeviceID,
		Username:   cfg.Hikvision.Username,
		Password:   cfg.Hikvision.Password,
		PageSize:   cfg.Hikvision.PageSize,
		Location:   location,
		Timeout:    time.Duration(cfg.Hikvision.RequestTimeoutSeconds) * time.Second,
		RetryCount: cfg.Hikvision.RetryCount,
	})
	var cloud *syncer.Client
	var realtimeClient realtimeCommandClient
	if cfg.Cloud.Enabled {
		cloud, err = syncer.New(syncer.Options{
			URL:               cfg.Cloud.IngestURL,
			DeviceID:          cfg.Hikvision.DeviceID,
			BridgeKey:         cfg.Cloud.BridgeKey,
			Timeout:           time.Duration(cfg.Cloud.RequestTimeoutSeconds) * time.Second,
			AllowInsecureHTTP: cfg.Cloud.AllowInsecureHTTP,
			AgentVersion:      version,
		})
		if err != nil {
			eventStore.Close()
			return nil, err
		}
		if cfg.Cloud.RealtimeEnabled {
			realtimeClient, err = bridgerealtime.New(bridgerealtime.Options{
				SessionURL:        cfg.Cloud.RealtimeSessionURL,
				DeviceID:          cfg.Hikvision.DeviceID,
				BridgeKey:         cfg.Cloud.BridgeKey,
				AgentVersion:      version,
				Timeout:           time.Duration(cfg.Cloud.RequestTimeoutSeconds) * time.Second,
				AllowInsecureHTTP: cfg.Cloud.AllowInsecureHTTP,
			})
			if err != nil {
				eventStore.Close()
				return nil, err
			}
		}
	}
	startedAt := time.Now()
	return &Runner{
		cfg:         cfg,
		log:         logger,
		device:      device,
		store:       eventStore,
		cloud:       cloud,
		realtime:    realtimeClient,
		version:     version,
		syncWake:    make(chan struct{}, 1),
		commandWake: make(chan struct{}, 1),
		status: Status{
			StartedAt:     startedAt,
			BridgeVersion: version,
		},
	}, nil
}

func (r *Runner) Close() error { return r.store.Close() }

func (r *Runner) refreshCounts() {
	counts, err := r.store.Counts()
	commandResults, commandErr := r.store.CommandResultCount()
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.status.LastStorageError = err.Error()
		return
	}
	if commandErr != nil {
		r.status.LastStorageError = commandErr.Error()
		return
	}
	r.status.PendingEvents = counts.Pending
	r.status.UploadingEvents = counts.Uploading
	r.status.SyncedEvents = counts.Synced
	r.status.FailedEvents = counts.Failed
	r.status.PendingCommandResults = commandResults
	r.status.LastStorageError = ""
}

func (r *Runner) Snapshot() Status {
	r.refreshCounts()
	r.mu.RLock()
	defer r.mu.RUnlock()
	snapshot := r.status
	snapshot.UptimeSeconds = int64(time.Since(snapshot.StartedAt).Seconds())
	return snapshot
}

func (r *Runner) refreshDeviceMetadata(ctx context.Context) {
	r.deviceMu.Lock()
	info, err := r.device.DeviceInfo(ctx)
	r.deviceMu.Unlock()
	if err != nil {
		r.log.Warn("device_metadata_failed", "device", r.cfg.Hikvision.DeviceID, "error", err)
		return
	}
	r.mu.Lock()
	r.status.DeviceModel = info.Model
	r.status.DeviceSerial = info.SerialNumber
	r.status.FirmwareVersion = info.FirmwareVersion
	r.mu.Unlock()
	r.log.Info(
		"device_metadata_loaded",
		"device", r.cfg.Hikvision.DeviceID,
		"model", info.Model,
		"serial", info.SerialNumber,
		"firmware", info.FirmwareVersion,
	)
}

func (r *Runner) pollOnce(ctx context.Context) error {
	end := time.Now()
	checkpoint, exists, err := r.store.GetCheckpoint()
	if err != nil {
		return fmt.Errorf("load polling checkpoint: %w", err)
	}
	start := end.Add(-time.Duration(r.cfg.Service.InitialLookbackHours) * time.Hour)
	if exists {
		start = checkpoint.Add(-time.Duration(r.cfg.Service.OverlapSeconds) * time.Second)
	}
	if start.After(end) {
		start = end.Add(-time.Duration(r.cfg.Service.OverlapSeconds) * time.Second)
	}

	r.deviceMu.Lock()
	result, err := r.device.SearchEventsDetailed(ctx, start, end)
	r.deviceMu.Unlock()
	r.mu.Lock()
	r.status.LastDevicePoll = time.Now()
	if err != nil {
		r.status.DeviceConnected = false
		r.status.LastDeviceError = err.Error()
	}
	r.mu.Unlock()
	if err != nil {
		return err
	}

	inserted := 0
	for _, event := range result.Events {
		created, err := r.store.PutIfAbsent(event)
		if err != nil {
			return fmt.Errorf("persist event %s: %w", event.ID, err)
		}
		if created {
			inserted++
		}
	}
	preservedIssues := 0
	for _, issue := range result.Issues {
		created, err := r.store.PreserveParseIssue(issue)
		if err != nil {
			return fmt.Errorf("preserve malformed device event: %w", err)
		}
		if created {
			preservedIssues++
		}
	}
	// The complete result window is durable before the checkpoint advances.
	// Overlap on the next poll captures records added near the boundary.
	if err := r.store.SetCheckpoint(end); err != nil {
		return fmt.Errorf("save polling checkpoint: %w", err)
	}

	r.mu.Lock()
	r.status.DeviceConnected = true
	r.status.LastSuccessfulDevicePoll = time.Now()
	r.status.LastDeviceError = ""
	r.status.EventsRetrieved += int64(len(result.Events) + len(result.Issues))
	r.status.EventsQueued += int64(inserted)
	needsMetadata := r.status.DeviceModel == ""
	r.mu.Unlock()
	if needsMetadata {
		r.refreshDeviceMetadata(ctx)
	}
	r.log.Info(
		"device_poll_success",
		"device", r.cfg.Hikvision.DeviceID,
		"events", len(result.Events),
		"queued", inserted,
		"parseIssues", preservedIssues,
	)
	if preservedIssues > 0 {
		r.log.Warn("device_events_preserved_with_parse_errors", "device", r.cfg.Hikvision.DeviceID, "count", preservedIssues)
	}
	if inserted > 0 {
		select {
		case r.syncWake <- struct{}{}:
		default:
		}
	}
	return nil
}

func eventIDs(events []model.AttendanceEvent) []string {
	ids := make([]string, 0, len(events))
	for _, event := range events {
		ids = append(ids, event.ID)
	}
	return ids
}

func (r *Runner) syncOnce(ctx context.Context) (int, error) {
	if r.cloud == nil {
		return 0, nil
	}
	events, err := r.store.PrepareBatch(r.cfg.Cloud.BatchSize)
	if err != nil {
		return 0, fmt.Errorf("prepare cloud batch: %w", err)
	}
	if len(events) == 0 {
		return 0, nil
	}
	ids := eventIDs(events)
	response, err := r.cloud.Send(ctx, events)
	if err != nil {
		if releaseErr := r.store.Release(ids, err); releaseErr != nil {
			return 0, errors.Join(err, fmt.Errorf("release failed upload batch: %w", releaseErr))
		}
		return 0, err
	}
	confirmed := append(append([]string{}, response.Accepted...), response.Duplicates...)
	if err := r.store.MarkSynced(confirmed); err != nil {
		return 0, fmt.Errorf("mark confirmed events synced: %w", err)
	}
	rejections := make(map[string]string, len(response.Rejected))
	for _, rejected := range response.Rejected {
		message := rejected.Code
		if rejected.Message != "" {
			message += ": " + rejected.Message
		}
		rejections[rejected.ID] = message
	}
	if err := r.store.MarkFailed(rejections); err != nil {
		return 0, fmt.Errorf("preserve rejected events: %w", err)
	}

	r.mu.Lock()
	r.status.LastCloudSync = time.Now()
	r.status.LastCloudError = ""
	r.status.EventsSynced += int64(len(confirmed))
	r.mu.Unlock()
	r.log.Info(
		"cloud_sync_success",
		"device", r.cfg.Hikvision.DeviceID,
		"accepted", len(response.Accepted),
		"duplicates", len(response.Duplicates),
		"rejected", len(response.Rejected),
	)
	return len(events), nil
}

func (r *Runner) SyncNow(ctx context.Context) (int, error) {
	if r.cloud == nil {
		return 0, errors.New("cloud sync is disabled")
	}
	total := 0
	for {
		processed, err := r.syncOnce(ctx)
		total += processed
		if err != nil {
			return total, err
		}
		if processed < r.cfg.Cloud.BatchSize {
			return total, nil
		}
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (r *Runner) startStatusServer(ctx context.Context) (*http.Server, <-chan error, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		snapshot := r.Snapshot()
		if err := json.NewEncoder(response).Encode(map[string]any{
			"ok":              true,
			"service":         "Infact HikBridge",
			"deviceConnected": snapshot.DeviceConnected,
		}); err != nil {
			r.log.Warn("diagnostics_encode_failed", "endpoint", "/health", "error", err)
		}
	})
	mux.HandleFunc("/status", func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(r.Snapshot()); err != nil {
			r.log.Warn("diagnostics_encode_failed", "endpoint", "/status", "error", err)
		}
	})
	listener, err := net.Listen("tcp", r.cfg.Service.LocalStatusAddress)
	if err != nil {
		return nil, nil, fmt.Errorf("listen on diagnostics address %s: %w", r.cfg.Service.LocalStatusAddress, err)
	}
	server := &http.Server{
		Addr:              r.cfg.Service.LocalStatusAddress,
		Handler:           mux,
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	result := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		result <- err
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			r.log.Warn("diagnostics_shutdown_failed", "error", err)
		}
	}()
	return server, result, nil
}

func (r *Runner) pollLoop(ctx context.Context, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	r.refreshDeviceMetadata(ctx)
	if err := r.pollOnce(ctx); err != nil && ctx.Err() == nil {
		r.log.Error("device_poll_failed", "device", r.cfg.Hikvision.DeviceID, "error", err)
	}
	ticker := time.NewTicker(time.Duration(r.cfg.Service.PollIntervalSeconds) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.pollOnce(ctx); err != nil && ctx.Err() == nil {
				r.log.Error("device_poll_failed", "device", r.cfg.Hikvision.DeviceID, "error", err)
			}
		}
	}
}

var retrySchedule = []time.Duration{
	5 * time.Second,
	15 * time.Second,
	30 * time.Second,
	time.Minute,
	5 * time.Minute,
}

const (
	realtimeFallbackInitial = 15 * time.Second
	realtimeFallbackMaximum = 30 * time.Second
)

func withJitter(delay time.Duration) time.Duration {
	span := delay / 5
	if span <= 0 {
		return delay
	}
	random, err := rand.Int(rand.Reader, big.NewInt(int64(span*2+1)))
	if err != nil {
		return delay
	}
	return delay - span + time.Duration(random.Int64())
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

func waitForWake(ctx context.Context, wake <-chan struct{}, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-timer.C:
		return true
	}
}

func (r *Runner) syncLoop(ctx context.Context, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	if r.cloud == nil {
		<-ctx.Done()
		return
	}
	failures := 0
	nextStatusReport := time.Time{}
	statusInterval := time.Duration(r.cfg.Service.StatusIntervalSeconds) * time.Second
	if r.realtime != nil && statusInterval < 4*time.Minute {
		// Realtime command delivery removes the need to use frequent ingestion
		// probes as command polls. Attendance uploads still wake immediately;
		// this interval is only the low-priority dashboard heartbeat.
		statusInterval = 4 * time.Minute
	}
	for {
		processed, err := r.syncOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if err == nil && !time.Now().Before(nextStatusReport) {
			snapshot := r.Snapshot()
			var lastSuccessfulPoll *time.Time
			if !snapshot.LastSuccessfulDevicePoll.IsZero() {
				value := snapshot.LastSuccessfulDevicePoll.UTC()
				lastSuccessfulPoll = &value
			}
			_, err = r.cloud.ReportStatus(ctx, syncer.BridgeStatus{
				DeviceConnected:          snapshot.DeviceConnected,
				LastSuccessfulDevicePoll: lastSuccessfulPoll,
				PendingEvents:            snapshot.PendingEvents + snapshot.UploadingEvents,
				DeviceModel:              snapshot.DeviceModel,
				DeviceSerial:             snapshot.DeviceSerial,
				FirmwareVersion:          snapshot.FirmwareVersion,
			})
			if err == nil {
				nextStatusReport = time.Now().Add(statusInterval)
			}
		}
		var delay time.Duration
		if err != nil {
			r.mu.Lock()
			r.status.LastCloudError = err.Error()
			r.status.CloudFailures++
			r.mu.Unlock()
			r.log.Error("cloud_sync_failed", "device", r.cfg.Hikvision.DeviceID, "error", err)
			index := min(failures, len(retrySchedule)-1)
			delay = withJitter(retrySchedule[index])
			failures++
		} else {
			failures = 0
			if processed == r.cfg.Cloud.BatchSize {
				delay = 250 * time.Millisecond
			} else {
				delay = time.Duration(r.cfg.Service.SyncIntervalSeconds) * time.Second
			}
		}
		if !waitForWake(ctx, r.syncWake, delay) {
			return
		}
	}
}

func commandError(code string, err error) model.CommandResult {
	message := strings.TrimSpace(err.Error())
	if len(message) > 500 {
		message = message[:500]
	}
	return model.CommandResult{State: "failed", Code: code, Message: message}
}

func (r *Runner) executeCommand(ctx context.Context, command model.DeviceCommand) model.CommandResult {
	result := model.CommandResult{CommandID: command.ID}
	if time.Now().After(command.ExpiresAt) {
		result = commandError("expired", errors.New("command expired before local execution"))
		result.CommandID = command.ID
		return result
	}
	provisioning := hikvision.UserProvisioning{
		EmployeeNo: command.Payload.EmployeeNo,
		Name:       command.Payload.Name,
	}
	if command.Type != model.CommandUpsertUser && command.Type != model.CommandEnrollFingerprint {
		result = commandError("unsupported_command", fmt.Errorf("unsupported command type %q", command.Type))
		result.CommandID = command.ID
		return result
	}
	userAlreadyProvisioned := false
	if command.Type == model.CommandEnrollFingerprint {
		cached, err := r.store.IsUserProvisioned(provisioning.EmployeeNo, provisioning.Name)
		if err != nil {
			r.log.Warn("provisioned_user_cache_read_failed", "employeeNo", provisioning.EmployeeNo, "error", err)
		} else {
			userAlreadyProvisioned = cached
		}
	}
	r.deviceMu.Lock()
	defer r.deviceMu.Unlock()
	if !userAlreadyProvisioned {
		if err := r.device.UpsertUser(ctx, provisioning); err != nil {
			result = commandError("user_sync_failed", err)
			result.CommandID = command.ID
			return result
		}
		if err := r.store.MarkUserProvisioned(provisioning.EmployeeNo, provisioning.Name); err != nil {
			r.log.Warn("provisioned_user_cache_write_failed", "employeeNo", provisioning.EmployeeNo, "error", err)
		}
	}
	if command.Type == model.CommandUpsertUser {
		result.State = "succeeded"
		result.Output = &model.CommandResultOutput{EmployeeNo: command.Payload.EmployeeNo}
		return result
	}
	capture, err := r.device.CaptureFingerprint(ctx, command.Payload.FingerPrintID)
	if err != nil {
		result = commandError("fingerprint_capture_failed", err)
		result.CommandID = command.ID
		return result
	}
	if err := r.device.SetFingerprint(ctx, command.Payload.EmployeeNo, capture); err != nil {
		if !userAlreadyProvisioned {
			result = commandError("fingerprint_setup_failed", err)
			result.CommandID = command.ID
			return result
		}
		// The local cache can become stale if an administrator removes the user
		// directly on the terminal. Repair that case once without asking the
		// employee to provide another fingerprint capture.
		if repairErr := r.device.UpsertUser(ctx, provisioning); repairErr != nil {
			result = commandError("fingerprint_setup_failed", fmt.Errorf("assign fingerprint: %v; repair terminal user: %w", err, repairErr))
			result.CommandID = command.ID
			return result
		}
		if cacheErr := r.store.MarkUserProvisioned(provisioning.EmployeeNo, provisioning.Name); cacheErr != nil {
			r.log.Warn("provisioned_user_cache_write_failed", "employeeNo", provisioning.EmployeeNo, "error", cacheErr)
		}
		if retryErr := r.device.SetFingerprint(ctx, command.Payload.EmployeeNo, capture); retryErr != nil {
			result = commandError("fingerprint_setup_failed", retryErr)
			result.CommandID = command.ID
			return result
		}
	}
	result.State = "succeeded"
	result.Output = &model.CommandResultOutput{
		EmployeeNo:    command.Payload.EmployeeNo,
		FingerPrintID: capture.FingerPrintID,
		Quality:       capture.Quality,
	}
	return result
}

func (r *Runner) exchangeCommandsOnce(ctx context.Context) (int, error) {
	results, err := r.store.CommandResults(20)
	if err != nil {
		return 0, fmt.Errorf("load pending command results: %w", err)
	}
	response, err := r.cloud.ExchangeCommands(ctx, results)
	if err != nil {
		return 0, err
	}
	if err := r.store.RemoveCommandResults(response.AcknowledgedCommandIDs); err != nil {
		return 0, fmt.Errorf("remove acknowledged command results: %w", err)
	}
	r.mu.Lock()
	r.status.LastCommandPoll = time.Now()
	r.status.LastCommandError = ""
	r.status.CommandsReceived += int64(len(response.Commands))
	r.mu.Unlock()

	processed := 0
	for _, command := range response.Commands {
		exists, err := r.store.HasCommandResult(command.ID)
		if err != nil {
			return processed, fmt.Errorf("check command receipt %s: %w", command.ID, err)
		}
		if exists {
			continue
		}
		// Persist a fail-safe receipt before touching the terminal. If the
		// process stops after the device operation but before the final result
		// is durable, restart reports an interrupted command instead of silently
		// asking for another fingerprint capture.
		if err := r.store.PutCommandResult(model.CommandResult{
			CommandID: command.ID,
			State:     "failed",
			Code:      "execution_interrupted",
			Message:   "Bridge stopped before command completion could be confirmed",
		}); err != nil {
			return processed, fmt.Errorf("persist command receipt %s: %w", command.ID, err)
		}
		r.mu.Lock()
		r.status.ActiveCommandID = command.ID
		r.status.ActiveCommandType = string(command.Type)
		r.mu.Unlock()
		r.log.Info("device_command_started", "device", r.cfg.Hikvision.DeviceID, "commandId", command.ID, "type", command.Type)
		commandTimeout := 30 * time.Second
		if command.Type == model.CommandEnrollFingerprint {
			// Capture alone can legitimately wait 45 seconds for a finger. Leave
			// enough time for terminal-user preparation and fingerprint assignment.
			commandTimeout = 2 * time.Minute
			if err := r.pollOnce(ctx); err != nil && ctx.Err() == nil {
				r.log.Warn("pre_enrollment_poll_failed", "device", r.cfg.Hikvision.DeviceID, "commandId", command.ID, "error", err)
			}
		}
		commandCtx, cancel := context.WithTimeout(ctx, commandTimeout)
		result := r.executeCommand(commandCtx, command)
		cancel()
		if command.Type == model.CommandEnrollFingerprint && ctx.Err() == nil {
			if err := r.pollOnce(ctx); err != nil {
				r.log.Warn("post_enrollment_poll_failed", "device", r.cfg.Hikvision.DeviceID, "commandId", command.ID, "error", err)
			}
		}
		if err := r.store.PutCommandResult(result); err != nil {
			return processed, fmt.Errorf("persist command result %s: %w", command.ID, err)
		}
		r.mu.Lock()
		r.status.ActiveCommandID = ""
		r.status.ActiveCommandType = ""
		if result.State == "succeeded" {
			r.status.CommandsSucceeded++
		} else {
			r.status.CommandsFailed++
			r.status.LastCommandError = result.Message
		}
		r.mu.Unlock()
		if result.State == "succeeded" {
			r.log.Info("device_command_succeeded", "device", r.cfg.Hikvision.DeviceID, "commandId", command.ID, "type", command.Type)
		} else {
			r.log.Warn("device_command_failed", "device", r.cfg.Hikvision.DeviceID, "commandId", command.ID, "type", command.Type, "code", result.Code, "error", result.Message)
		}
		processed++
	}
	return processed, nil
}

func (r *Runner) legacyCommandLoop(ctx context.Context) {
	for {
		processed, err := r.exchangeCommandsOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		delay := time.Duration(r.cfg.Service.SyncIntervalSeconds) * time.Second
		if err != nil {
			r.recordCommandExchangeError(err)
			delay = withJitter(15 * time.Second)
		} else if processed > 0 {
			delay = 250 * time.Millisecond
		}
		if !wait(ctx, delay) {
			return
		}
	}
}

func (r *Runner) recordCommandExchangeError(err error) {
	r.mu.Lock()
	r.status.LastCommandPoll = time.Now()
	r.status.LastCommandError = err.Error()
	r.mu.Unlock()
	r.log.Error("device_command_exchange_failed", "device", r.cfg.Hikvision.DeviceID, "error", err)
}

func resetTimer(timer **time.Timer, timerC *<-chan time.Time, delay time.Duration) {
	if *timer == nil {
		*timer = time.NewTimer(delay)
	} else {
		if !(*timer).Stop() {
			select {
			case <-(*timer).C:
			default:
			}
		}
		(*timer).Reset(delay)
	}
	*timerC = (*timer).C
}

func stopTimer(timer *time.Timer, timerC *<-chan time.Time) {
	if timer != nil && !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	*timerC = nil
}

func (r *Runner) commandLoop(ctx context.Context, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	if r.cloud == nil {
		<-ctx.Done()
		return
	}
	if r.realtime == nil {
		r.legacyCommandLoop(ctx)
		return
	}

	states := make(chan bool, 2)
	go r.realtime.Run(ctx,
		func() {
			select {
			case r.commandWake <- struct{}{}:
			default:
			}
		},
		func(connected bool) {
			select {
			case states <- connected:
			default:
			}
		},
		func(err error) {
			r.mu.Lock()
			r.status.LastRealtimeError = err.Error()
			r.mu.Unlock()
			r.log.Warn("realtime_command_stream_error", "device", r.cfg.Hikvision.DeviceID, "error", err)
		},
	)

	connected := false
	startupReconciled := false
	fallbackDelay := realtimeFallbackInitial
	var timer *time.Timer
	var timerC <-chan time.Time
	resetTimer(&timer, &timerC, 0)
	defer func() { stopTimer(timer, &timerC) }()
	for {
		select {
		case <-ctx.Done():
			return
		case state := <-states:
			connected = state
			r.mu.Lock()
			r.status.RealtimeConnected = state
			if state {
				r.status.LastRealtimeConnect = time.Now()
				r.status.LastRealtimeError = ""
			}
			r.mu.Unlock()
			if state {
				fallbackDelay = realtimeFallbackInitial
				if startupReconciled {
					stopTimer(timer, &timerC)
				}
			} else {
				resetTimer(&timer, &timerC, withJitter(fallbackDelay))
			}
		case <-r.commandWake:
			resetTimer(&timer, &timerC, 0)
		case <-timerC:
			timerC = nil
			startupReconciled = true
			processed, err := r.exchangeCommandsOnce(ctx)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				r.recordCommandExchangeError(err)
				resetTimer(&timer, &timerC, withJitter(realtimeFallbackInitial))
				continue
			}
			if processed > 0 {
				// Immediately acknowledge the durable result and collect the next
				// command without waiting for another realtime notification.
				resetTimer(&timer, &timerC, 250*time.Millisecond)
				continue
			}
			if !connected {
				fallbackDelay = min(fallbackDelay*2, realtimeFallbackMaximum)
				resetTimer(&timer, &timerC, withJitter(fallbackDelay))
			}
		}
	}
}

func (r *Runner) maintenanceLoop(ctx context.Context, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	prune := func() {
		cutoff := time.Now().UTC().AddDate(0, 0, -r.cfg.Service.SyncedRetentionDays)
		removed, err := r.store.PruneSynced(cutoff)
		if err != nil {
			r.log.Error("synced_retention_failed", "error", err)
			return
		}
		if removed > 0 {
			r.log.Info("synced_retention_complete", "removed", removed, "retentionDays", r.cfg.Service.SyncedRetentionDays)
		}
	}
	prune()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prune()
		}
	}
}

func (r *Runner) Run(parent context.Context) error {
	if !r.running.CompareAndSwap(false, true) {
		return errors.New("runner already running")
	}
	defer r.running.Store(false)
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	_, serverResult, err := r.startStatusServer(ctx)
	if err != nil {
		return err
	}
	done := make(chan struct{}, 4)
	go r.pollLoop(ctx, done)
	go r.syncLoop(ctx, done)
	go r.commandLoop(ctx, done)
	go r.maintenanceLoop(ctx, done)

	select {
	case <-parent.Done():
		cancel()
	case err := <-serverResult:
		cancel()
		if err != nil {
			return fmt.Errorf("diagnostics server stopped: %w", err)
		}
	}
	<-done
	<-done
	<-done
	<-done
	return nil
}
