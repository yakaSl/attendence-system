package store

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"infactsolutions/hikbridge/internal/atomicfile"
	"infactsolutions/hikbridge/internal/model"
)

const recordSchemaVersion = 1

type SyncState string

const (
	StatePending   SyncState = "pending"
	StateUploading SyncState = "uploading"
	StateSynced    SyncState = "synced"
	StateFailed    SyncState = "failed"
)

type Record struct {
	SchemaVersion     int                   `json:"schemaVersion"`
	Event             model.AttendanceEvent `json:"event"`
	FirstSeenAt       time.Time             `json:"firstSeenAt"`
	LastUploadAttempt *time.Time            `json:"lastUploadAttempt,omitempty"`
	AttemptCount      int                   `json:"attemptCount"`
	SyncState         SyncState             `json:"syncState"`
	ErrorMessage      string                `json:"errorMessage,omitempty"`
}

type FailureRecord struct {
	SchemaVersion  int             `json:"schemaVersion"`
	Kind           string          `json:"kind"`
	ID             string          `json:"id"`
	DeviceID       string          `json:"deviceId,omitempty"`
	FirstSeenAt    time.Time       `json:"firstSeenAt"`
	ErrorMessage   string          `json:"errorMessage"`
	Raw            json.RawMessage `json:"raw,omitempty"`
	OriginalBase64 string          `json:"originalBase64,omitempty"`
}

type EventCounts struct {
	Pending   int `json:"pending"`
	Uploading int `json:"uploading"`
	Synced    int `json:"synced"`
	Failed    int `json:"failed"`
}

type Store struct {
	root              string
	pendingDir        string
	syncedDir         string
	failedDir         string
	commandResultsDir string
	mu                sync.Mutex
}

var eventIDRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commandIDRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var commandResultCodeRE = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

func Open(dataDir string) (*Store, error) {
	s := &Store{
		root:              dataDir,
		pendingDir:        filepath.Join(dataDir, "events", "pending"),
		syncedDir:         filepath.Join(dataDir, "events", "synced"),
		failedDir:         filepath.Join(dataDir, "events", "failed"),
		commandResultsDir: filepath.Join(dataDir, "commands", "results"),
	}
	for _, dir := range []string{s.pendingDir, s.syncedDir, s.failedDir, s.commandResultsDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, fmt.Errorf("create event store directory: %w", err)
		}
	}
	if err := s.recoverPending(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return nil }

func safeEventFilename(id string) (string, error) {
	if !eventIDRE.MatchString(id) {
		return "", fmt.Errorf("invalid event ID %q", id)
	}
	return id + ".json", nil
}

func marshalRecord(record Record) ([]byte, error) {
	return json.MarshalIndent(record, "", "  ")
}

func readRecord(path string) (Record, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Record{}, nil, err
	}
	var wrapped Record
	if err := json.Unmarshal(b, &wrapped); err == nil && wrapped.Event.ID != "" {
		if wrapped.SchemaVersion != recordSchemaVersion {
			return Record{}, b, fmt.Errorf("unsupported record schema version %d", wrapped.SchemaVersion)
		}
		return wrapped, b, nil
	}

	// v0.1 wrote the event object directly. Read it without mutating the source;
	// the next state change migrates it to the versioned wrapper.
	var legacy model.AttendanceEvent
	if err := json.Unmarshal(b, &legacy); err != nil {
		return Record{}, b, fmt.Errorf("decode event record: %w", err)
	}
	if legacy.ID == "" {
		return Record{}, b, errors.New("event record has no ID")
	}
	firstSeen := legacy.ReceivedAt
	if firstSeen.IsZero() {
		if info, err := os.Stat(path); err == nil {
			firstSeen = info.ModTime().UTC()
		} else {
			firstSeen = time.Now().UTC()
		}
	}
	return Record{
		SchemaVersion: recordSchemaVersion,
		Event:         legacy,
		FirstSeenAt:   firstSeen,
		SyncState:     StatePending,
	}, b, nil
}

func writeRecord(path string, record Record) error {
	b, err := marshalRecord(record)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, b, 0600)
}

func (s *Store) recoverPending() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.pendingDir)
	if err != nil {
		return fmt.Errorf("read pending store during recovery: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		pendingPath := filepath.Join(s.pendingDir, entry.Name())
		syncedPath := filepath.Join(s.syncedDir, entry.Name())
		if _, err := os.Stat(syncedPath); err == nil {
			if err := os.Remove(pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove recovered duplicate pending record: %w", err)
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}

		record, original, err := readRecord(pendingPath)
		if err != nil {
			if qErr := s.quarantineCorruptLocked(entry.Name(), original, err); qErr != nil {
				return qErr
			}
			continue
		}
		if record.SyncState == StateUploading {
			record.SyncState = StatePending
			record.ErrorMessage = "recovered after an interrupted upload"
			if err := writeRecord(pendingPath, record); err != nil {
				return fmt.Errorf("recover uploading record %s: %w", entry.Name(), err)
			}
		}
	}
	return nil
}

func (s *Store) PutIfAbsent(ev model.AttendanceEvent) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	name, err := safeEventFilename(ev.ID)
	if err != nil {
		return false, err
	}
	for _, dir := range []string{s.pendingDir, s.syncedDir, s.failedDir} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return false, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	firstSeen := time.Now().UTC()
	if !ev.ReceivedAt.IsZero() {
		firstSeen = ev.ReceivedAt.UTC()
	}
	record := Record{
		SchemaVersion: recordSchemaVersion,
		Event:         ev,
		FirstSeenAt:   firstSeen,
		SyncState:     StatePending,
	}
	if err := writeRecord(filepath.Join(s.pendingDir, name), record); err != nil {
		return false, err
	}
	return true, nil
}

func pendingNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func (s *Store) PrepareBatch(limit int) ([]model.AttendanceEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		return nil, errors.New("batch limit must be positive")
	}

	names, err := pendingNames(s.pendingDir)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	events := make([]model.AttendanceEvent, 0, min(limit, len(names)))
	for _, name := range names {
		if len(events) >= limit {
			break
		}
		path := filepath.Join(s.pendingDir, name)
		record, original, err := readRecord(path)
		if err != nil {
			if qErr := s.quarantineCorruptLocked(name, original, err); qErr != nil {
				return nil, qErr
			}
			continue
		}
		if record.SyncState == StateFailed || record.SyncState == StateSynced {
			destination := s.failedDir
			if record.SyncState == StateSynced {
				destination = s.syncedDir
			}
			if err := writeRecord(filepath.Join(destination, name), record); err != nil {
				return nil, err
			}
			if err := os.Remove(path); err != nil {
				return nil, err
			}
			continue
		}
		record.SyncState = StateUploading
		record.AttemptCount++
		record.LastUploadAttempt = &now
		record.ErrorMessage = ""
		if err := writeRecord(path, record); err != nil {
			return nil, err
		}
		events = append(events, record.Event)
	}
	return events, nil
}

func truncateError(message string) string {
	message = strings.TrimSpace(message)
	if len(message) > 1000 {
		return message[:1000]
	}
	return message
}

func (s *Store) Release(ids []string, cause error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message := "upload failed"
	if cause != nil {
		message = truncateError(cause.Error())
	}
	for _, id := range ids {
		name, err := safeEventFilename(id)
		if err != nil {
			return err
		}
		path := filepath.Join(s.pendingDir, name)
		record, _, err := readRecord(path)
		if errors.Is(err, os.ErrNotExist) {
			if _, syncedErr := os.Stat(filepath.Join(s.syncedDir, name)); syncedErr == nil {
				continue
			}
		}
		if err != nil {
			return err
		}
		record.SyncState = StatePending
		record.ErrorMessage = message
		if err := writeRecord(path, record); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) MarkSynced(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		name, err := safeEventFilename(id)
		if err != nil {
			return err
		}
		src := filepath.Join(s.pendingDir, name)
		dst := filepath.Join(s.syncedDir, name)
		if _, err := os.Stat(dst); err == nil {
			if err := os.Remove(src); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			continue
		}
		record, _, err := readRecord(src)
		if err != nil {
			return err
		}
		record.SyncState = StateSynced
		record.ErrorMessage = ""
		if err := writeRecord(dst, record); err != nil {
			return err
		}
		if err := os.Remove(src); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *Store) MarkFailed(rejections map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, message := range rejections {
		name, err := safeEventFilename(id)
		if err != nil {
			return err
		}
		src := filepath.Join(s.pendingDir, name)
		dst := filepath.Join(s.failedDir, name)
		record, _, err := readRecord(src)
		if err != nil {
			return err
		}
		record.SyncState = StateFailed
		record.ErrorMessage = truncateError(message)
		if err := writeRecord(dst, record); err != nil {
			return err
		}
		if err := os.Remove(src); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *Store) PreserveParseIssue(issue model.ParseIssue) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := sha256.Sum256(append([]byte(issue.DeviceID+"|"), issue.Raw...))
	id := hex.EncodeToString(hash[:])
	name := "parse-" + id + ".json"
	path := filepath.Join(s.failedDir, name)
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	record := FailureRecord{
		SchemaVersion: recordSchemaVersion,
		Kind:          "device_parse_error",
		ID:            id,
		DeviceID:      issue.DeviceID,
		FirstSeenAt:   time.Now().UTC(),
		ErrorMessage:  truncateError(issue.Message),
		Raw:           append(json.RawMessage(nil), issue.Raw...),
	}
	b, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return false, err
	}
	if err := atomicfile.WriteFile(path, b, 0600); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) quarantineCorruptLocked(name string, original []byte, cause error) error {
	hash := sha256.Sum256(append([]byte(name+"|"), original...))
	id := hex.EncodeToString(hash[:])
	record := FailureRecord{
		SchemaVersion:  recordSchemaVersion,
		Kind:           "corrupt_local_record",
		ID:             id,
		FirstSeenAt:    time.Now().UTC(),
		ErrorMessage:   truncateError(cause.Error()),
		OriginalBase64: base64.StdEncoding.EncodeToString(original),
	}
	b, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(s.failedDir, "corrupt-"+id+".json"), b, 0600); err != nil {
		return fmt.Errorf("preserve corrupt queue record: %w", err)
	}
	if err := os.Remove(filepath.Join(s.pendingDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove quarantined queue record: %w", err)
	}
	return nil
}

func countJSONFiles(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			n++
		}
	}
	return n, nil
}

func (s *Store) Counts() (EventCounts, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var counts EventCounts
	names, err := pendingNames(s.pendingDir)
	if err != nil {
		return counts, err
	}
	for _, name := range names {
		record, _, err := readRecord(filepath.Join(s.pendingDir, name))
		if err != nil {
			counts.Failed++
			continue
		}
		if record.SyncState == StateUploading {
			counts.Uploading++
		} else {
			counts.Pending++
		}
	}
	counts.Synced, err = countJSONFiles(s.syncedDir)
	if err != nil {
		return EventCounts{}, err
	}
	failed, err := countJSONFiles(s.failedDir)
	if err != nil {
		return EventCounts{}, err
	}
	counts.Failed += failed
	return counts, nil
}

// PruneSynced removes only records already acknowledged by the cloud and older
// than the supplied cutoff. Pending and failed evidence is never pruned.
func (s *Store) PruneSynced(cutoff time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	names, err := pendingNames(s.syncedDir)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, name := range names {
		path := filepath.Join(s.syncedDir, name)
		record, _, err := readRecord(path)
		if err != nil {
			return removed, fmt.Errorf("read synced record %s for retention: %w", name, err)
		}
		if record.FirstSeenAt.Before(cutoff) {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return removed, fmt.Errorf("remove expired synced record %s: %w", name, err)
			}
			removed++
		}
	}
	return removed, nil
}

func (s *Store) GetCheckpoint() (time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(filepath.Join(s.root, "checkpoint.txt"))
	if errors.Is(err, os.ErrNotExist) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	ns, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("decode checkpoint: %w", err)
	}
	return time.Unix(0, ns), true, nil
}

func (s *Store) SetCheckpoint(t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return atomicfile.WriteFile(
		filepath.Join(s.root, "checkpoint.txt"),
		[]byte(strconv.FormatInt(t.UnixNano(), 10)),
		0600,
	)
}

func safeCommandFilename(id string) (string, error) {
	if !commandIDRE.MatchString(id) {
		return "", fmt.Errorf("invalid command ID %q", id)
	}
	return id + ".json", nil
}

func validateCommandResult(result model.CommandResult) error {
	if _, err := safeCommandFilename(result.CommandID); err != nil {
		return err
	}
	if result.State != "succeeded" && result.State != "failed" {
		return errors.New("command result state must be succeeded or failed")
	}
	if (result.Code != "" && !commandResultCodeRE.MatchString(result.Code)) || len(result.Message) > 500 {
		return errors.New("command result error details exceed the size limit")
	}
	if result.Output != nil && (len(result.Output.EmployeeNo) > 32 || result.Output.FingerPrintID < 0 ||
		result.Output.FingerPrintID > 10 || result.Output.Quality < 0 || result.Output.Quality > 100) {
		return errors.New("command result output is outside the device capability")
	}
	return nil
}

// PutCommandResult durably preserves a terminal command result until the cloud
// explicitly acknowledges it. A redelivered command can therefore be skipped
// without repeating a user or fingerprint operation.
func (s *Store) PutCommandResult(result model.CommandResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateCommandResult(result); err != nil {
		return err
	}
	name, _ := safeCommandFilename(result.CommandID)
	b, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("encode command result: %w", err)
	}
	return atomicfile.WriteFile(filepath.Join(s.commandResultsDir, name), b, 0600)
}

func (s *Store) HasCommandResult(commandID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := safeCommandFilename(commandID)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(filepath.Join(s.commandResultsDir, name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) CommandResults(limit int) ([]model.CommandResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit < 1 || limit > 20 {
		return nil, errors.New("command result limit must be between 1 and 20")
	}
	names, err := pendingNames(s.commandResultsDir)
	if err != nil {
		return nil, err
	}
	results := make([]model.CommandResult, 0, min(limit, len(names)))
	for _, name := range names {
		if len(results) >= limit {
			break
		}
		b, err := os.ReadFile(filepath.Join(s.commandResultsDir, name))
		if err != nil {
			return nil, err
		}
		var result model.CommandResult
		if err := json.Unmarshal(b, &result); err != nil {
			return nil, fmt.Errorf("decode command result %s: %w", name, err)
		}
		if err := validateCommandResult(result); err != nil {
			return nil, fmt.Errorf("invalid command result %s: %w", name, err)
		}
		results = append(results, result)
	}
	return results, nil
}

func (s *Store) RemoveCommandResults(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		name, err := safeCommandFilename(id)
		if err != nil {
			return err
		}
		if err := os.Remove(filepath.Join(s.commandResultsDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *Store) CommandResultCount() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return countJSONFiles(s.commandResultsDir)
}
