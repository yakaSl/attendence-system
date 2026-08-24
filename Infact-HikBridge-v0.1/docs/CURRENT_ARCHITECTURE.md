# Current Architecture

Audit date: 2026-08-23

This document describes the repository as it existed at the start of the audit. It does not describe the target architecture or planned behavior.

## Repository boundary

The repository currently contains one Go module, `infactsolutions/hikbridge`, under `Infact-HikBridge-v0.1`. There is no Firebase workspace, web dashboard, installer project, CI configuration, or automated test suite.

```text
cmd/hikbridge/main.go           CLI entry point and file logger
internal/bridge/runner.go       Poll/sync loop and localhost diagnostics
internal/config/config.go       JSON configuration and defaults
internal/hikvision/client.go    Hikvision ISAPI requests and event parsing
internal/hikvision/digest.go    HTTP Digest challenge/response support
internal/model/event.go         Normalized event and deterministic ID
internal/store/store.go         File-backed pending/synced event store
internal/syncer/client.go       HMAC-authenticated HTTP batch uploader
internal/winservice/            Windows Service adapter and non-Windows stub
config.example.json             Example service/device/cloud configuration
install-folder.ps1              ProgramData directory and ACL bootstrap
```

The module declares Go 1.23 and depends only on `golang.org/x/sys` for Windows Service integration.

## Runtime flow

`cmd/hikbridge` loads a JSON configuration, normalizes the Hikvision base URL, opens a text log file, constructs a `bridge.Runner`, and starts it either interactively or through the Windows Service Control Manager.

The runner performs one device poll and one cloud-sync attempt at startup. It then uses a polling ticker configured by `service.pollIntervalSeconds` and a fixed five-second cloud-sync ticker. Both operations run serially in the same goroutine.

```text
Hikvision AcsEvent search
  -> normalize each parseable InfoList item
  -> calculate SHA-256 event ID
  -> write events/pending/<event-id>.json
  -> update checkpoint.txt
  -> POST a pending batch when cloud is enabled
  -> move confirmed-by-HTTP-status files to events/synced/
```

## Configuration

`internal/config` reads a single JSON file. On Windows its default path is `C:\ProgramData\Infact\HikBridge\config.json`. Defaults are applied for polling, lookback, overlap, diagnostic address, data directory, Hikvision page size, and cloud batch size.

Validation currently requires a device ID, Hikvision base URL, username, and password. When cloud sync is enabled it also requires an ingest URL and bridge key. The Hikvision password and bridge key remain plaintext in the local JSON configuration.

## Hikvision communication

The client uses an `http.Client` with a 12-second overall timeout and a small custom HTTP Digest wrapper. Each request is first sent without authorization. On a 401 response, the wrapper parses the Digest challenge, creates one Authorization header, and retries once. Challenge state and authenticated connections are not proactively reused at the application level.

Implemented ISAPI operations are:

- `GET /ISAPI/System/deviceInfo`, used only as a success/failure connection test.
- `GET /ISAPI/AccessControl/UserInfo/Count?format=json`, used to return a user count.
- `POST /ISAPI/AccessControl/AcsEvent?format=json`, used to search access events.

Event search uses `major=5`, `minor=0`, a generated search ID, result positions, a maximum page size of 30, and a hard pagination-position ceiling of 100,000. Search times are sent with numeric UTC offsets.

Each `InfoList` member is retained as `json.RawMessage`. Known fields are normalized into `model.AttendanceEvent`. RFC3339 timestamps are accepted; timestamps without an offset are interpreted in the Windows host's local timezone. Entries with invalid JSON or timestamps are silently skipped.

## Event identity

`model.NewEventID` hashes this canonical input with SHA-256:

```text
device ID | serial number | UTC timestamp | employee number | major | minor
```

Repeated retrieval of an event with identical normalized identity fields therefore creates the same 64-character lowercase hexadecimal ID.

The normalized model currently includes the local device ID, event serial number, employee number/name, time, major/minor values, attendance status, verification mode, card/reader/door data, raw event JSON, and local receipt time. It does not contain the Hikvision device serial number.

## Local persistence

The store uses one JSON file per event:

```text
<dataDir>/events/pending/<event-id>.json
<dataDir>/events/synced/<event-id>.json
<dataDir>/checkpoint.txt
```

Writes go to a fixed `.tmp` sibling and are renamed into place. An in-process mutex serializes store operations. Duplicate detection checks both pending and synced paths. A sync marks events by moving their files from pending to synced. Synced files are retained indefinitely.

The checkpoint stores the latest scanned event time as Unix nanoseconds. Each poll starts at the checkpoint minus the configured overlap. If a successful poll returns no events, the checkpoint advances to the poll's start-time snapshot (`now`). Events are written before the checkpoint is updated.

## Cloud upload

Cloud sync is optional. The uploader serializes a device ID and normalized event array, and signs `timestamp + "." + exact request body` with HMAC-SHA256. It sends:

```text
X-HikBridge-Device
X-HikBridge-Timestamp
X-HikBridge-Signature
```

The client has a 15-second timeout. Any HTTP 2xx response is treated as confirmation for every event in the batch. Response JSON is not parsed. A failed request leaves all files pending.

## Diagnostics and logging

The runner exposes unauthenticated `/health` and `/status` endpoints at the configured address, which defaults to `127.0.0.1:8765`. Status reports start time, last poll, last successful poll, last cloud sync, one shared last-error string, buffered count, and total event count.

Logs use Go `slog` text output in `<dataDir>/hikbridge.log`. There is no rotation. Interactive `run` also logs to this file rather than standard output.

## Windows Service

The service name is `InfactHikBridge`, display name is `Infact Hikvision Bridge`, and startup type is automatic. The Windows handler accepts stop and shutdown requests, cancels the runner context, and waits up to ten seconds.

The CLI currently implements:

- `run`
- `test-device`
- `test-events --minutes N`
- `install`
- `uninstall`

It does not implement `test-users`, raw event output, `start`, `stop`, `restart`, `status`, `test-cloud`, or `sync-now`.

`install-folder.ps1` creates and locks down the ProgramData directory. There is no build script, service lifecycle script set, service recovery configuration, binary installation copy step, or installer package.

## Tests and build state at audit

There were no `_test.go` files or fixtures. Go formatting was already clean. The repository initially omitted `go.sum`, so a clean build failed until `go mod tidy` generated the dependency checksums. After that minimal fix, `go test ./...`, `go vet ./...`, and a Windows executable build completed; every package reported `[no test files]`.
