package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infactsolutions/hikbridge/internal/model"
)

func sampleEvent(serial int64) model.AttendanceEvent {
	timestamp := time.Date(2026, 8, 23, 8, 47, int(serial%60), 0, time.FixedZone("LKT", 5*60*60+30*60))
	event := model.AttendanceEvent{
		DeviceID:   "office-main-01",
		SerialNo:   serial,
		EmployeeNo: "17",
		EventTime:  timestamp,
		Major:      5,
		Minor:      75,
		Raw:        []byte(`{"serialNo":1,"unknown":"preserved"}`),
		ReceivedAt: time.Now().UTC(),
	}
	event.ID = model.NewEventID(event.DeviceID, event.SerialNo, event.EventTime, event.EmployeeNo, event.Major, event.Minor)
	return event
}

func TestPutIfAbsentDeduplicatesAcrossStates(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	event := sampleEvent(4101)
	created, err := store.PutIfAbsent(event)
	if err != nil || !created {
		t.Fatalf("first insert: created=%t err=%v", created, err)
	}
	created, err = store.PutIfAbsent(event)
	if err != nil || created {
		t.Fatalf("duplicate pending insert: created=%t err=%v", created, err)
	}
	batch, err := store.PrepareBatch(10)
	if err != nil || len(batch) != 1 {
		t.Fatalf("prepare batch: len=%d err=%v", len(batch), err)
	}
	if err := store.MarkSynced([]string{event.ID}); err != nil {
		t.Fatal(err)
	}
	created, err = store.PutIfAbsent(event)
	if err != nil || created {
		t.Fatalf("duplicate synced insert: created=%t err=%v", created, err)
	}
	counts, err := store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if counts.Synced != 1 || counts.Pending != 0 || counts.Uploading != 0 {
		t.Fatalf("unexpected counts: %+v", counts)
	}
}

func TestCheckpointCanBeReplacedRepeatedly(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := time.Date(2026, 8, 23, 8, 0, 0, 0, time.UTC)
	second := first.Add(5 * time.Minute)
	if err := store.SetCheckpoint(first); err != nil {
		t.Fatal(err)
	}
	if err := store.SetCheckpoint(second); err != nil {
		t.Fatalf("replace checkpoint: %v", err)
	}
	actual, exists, err := store.GetCheckpoint()
	if err != nil || !exists || !actual.Equal(second) {
		t.Fatalf("checkpoint=%v exists=%t err=%v", actual, exists, err)
	}
}

func TestInterruptedUploadIsRecoveredAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	first, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	event := sampleEvent(4102)
	if _, err := first.PutIfAbsent(event); err != nil {
		t.Fatal(err)
	}
	if batch, err := first.PrepareBatch(1); err != nil || len(batch) != 1 {
		t.Fatalf("prepare interrupted batch: len=%d err=%v", len(batch), err)
	}
	counts, _ := first.Counts()
	if counts.Uploading != 1 {
		t.Fatalf("uploading counts before restart: %+v", counts)
	}
	_ = first.Close()

	restarted, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	counts, err = restarted.Counts()
	if err != nil || counts.Pending != 1 || counts.Uploading != 0 {
		t.Fatalf("counts after restart: %+v err=%v", counts, err)
	}
	batch, err := restarted.PrepareBatch(1)
	if err != nil || len(batch) != 1 || batch[0].ID != event.ID {
		t.Fatalf("recovered batch=%+v err=%v", batch, err)
	}
}

func TestCorruptPendingRecordIsPreservedAndDoesNotBlockQueue(t *testing.T) {
	dataDir := t.TempDir()
	store, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	valid := sampleEvent(4103)
	if _, err := store.PutIfAbsent(valid); err != nil {
		t.Fatal(err)
	}
	corruptID := strings.Repeat("a", 64)
	corruptPath := filepath.Join(dataDir, "events", "pending", corruptID+".json")
	if err := os.WriteFile(corruptPath, []byte("not-json-evidence"), 0600); err != nil {
		t.Fatal(err)
	}
	batch, err := store.PrepareBatch(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch) != 1 || batch[0].ID != valid.ID {
		t.Fatalf("valid queue record was blocked: %+v", batch)
	}
	failedFiles, err := filepath.Glob(filepath.Join(dataDir, "events", "failed", "corrupt-*.json"))
	if err != nil || len(failedFiles) != 1 {
		t.Fatalf("failed files=%v err=%v", failedFiles, err)
	}
	preserved, err := os.ReadFile(failedFiles[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(preserved), "OriginalBase64") && !strings.Contains(string(preserved), "originalBase64") {
		t.Fatal("corrupt source bytes were not preserved")
	}
}

func TestReleaseAndPermanentRejectionRetainRecords(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, second := sampleEvent(4104), sampleEvent(4105)
	for _, event := range []model.AttendanceEvent{first, second} {
		if _, err := store.PutIfAbsent(event); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.PrepareBatch(2); err != nil {
		t.Fatal(err)
	}
	if err := store.Release([]string{first.ID}, os.ErrDeadlineExceeded); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkFailed(map[string]string{second.ID: "invalid_event: timestamp out of range"}); err != nil {
		t.Fatal(err)
	}
	counts, err := store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if counts.Pending != 1 || counts.Failed != 1 {
		t.Fatalf("records were not retained in expected states: %+v", counts)
	}
}

func TestPruneSyncedNeverTouchesPendingOrRecentEvidence(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	oldSynced, recentSynced, oldPending := sampleEvent(4201), sampleEvent(4202), sampleEvent(4203)
	oldSynced.ReceivedAt = time.Now().UTC().AddDate(0, 0, -100)
	recentSynced.ReceivedAt = time.Now().UTC().AddDate(0, 0, -2)
	oldPending.ReceivedAt = time.Now().UTC().AddDate(0, 0, -100)
	for _, event := range []model.AttendanceEvent{oldSynced, recentSynced, oldPending} {
		if _, err := store.PutIfAbsent(event); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.PrepareBatch(3); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkSynced([]string{oldSynced.ID, recentSynced.ID}); err != nil {
		t.Fatal(err)
	}
	if err := store.Release([]string{oldPending.ID}, errors.New("offline")); err != nil {
		t.Fatal(err)
	}
	removed, err := store.PruneSynced(time.Now().UTC().AddDate(0, 0, -90))
	if err != nil {
		t.Fatal(err)
	}
	counts, err := store.Counts()
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 || counts.Synced != 1 || counts.Pending != 1 {
		t.Fatalf("removed=%d counts=%+v", removed, counts)
	}
}

func TestCommandResultPersistsUntilExplicitCloudAcknowledgement(t *testing.T) {
	dataDir := t.TempDir()
	first, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	result := model.CommandResult{
		CommandID: "command-17",
		State:     "succeeded",
		Output: &model.CommandResultOutput{
			EmployeeNo:    "EMP-17",
			FingerPrintID: 2,
			Quality:       87,
		},
	}
	if err := first.PutCommandResult(result); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()

	restarted, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	results, err := restarted.CommandResults(20)
	if err != nil || len(results) != 1 || results[0].CommandID != result.CommandID {
		t.Fatalf("durable command results = %+v err=%v", results, err)
	}
	if exists, err := restarted.HasCommandResult(result.CommandID); err != nil || !exists {
		t.Fatalf("result existence before acknowledgement = %t err=%v", exists, err)
	}
	if err := restarted.RemoveCommandResults([]string{result.CommandID}); err != nil {
		t.Fatal(err)
	}
	if count, err := restarted.CommandResultCount(); err != nil || count != 0 {
		t.Fatalf("result count after acknowledgement = %d err=%v", count, err)
	}
}
