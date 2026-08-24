# Hikvision Integration

## Supported behavior

The bridge is designed around Hikvision ISAPI shapes observed/expected for the DS-K1A8503EF family. Firmware variants are handled defensively: JSON and selected XML envelopes are accepted, optional fields remain optional, unknown event data is kept in `raw`, response bodies are bounded, and malformed event entries are preserved as failed evidence instead of advancing silently past them.

Physical compatibility still must be confirmed against the exact customer firmware before release.

## Endpoints

```text
GET  /ISAPI/System/deviceInfo?format=json
GET  /ISAPI/System/time?format=json
GET  /ISAPI/AccessControl/UserInfo/Count?format=json
POST /ISAPI/AccessControl/UserInfo/Search?format=json
POST /ISAPI/AccessControl/UserInfo/Record?format=json
PUT  /ISAPI/AccessControl/UserInfo/SetUp?format=json
POST /ISAPI/AccessControl/CaptureFingerPrint
POST /ISAPI/AccessControl/FingerPrint/SetUp?format=json
POST /ISAPI/AccessControl/AcsEvent?format=json
```

The event search requests access-control major type `5` and paginates at no more than 30 matches per page. Pagination stops from device-reported total/count/status and protects against non-advancing or inconsistent pages.

Employee provisioning first searches by `EmployeeNoList`, then creates with `UserInfo/Record` or updates with `UserInfo/SetUp`. Fingerprint enrollment asks the terminal to capture one finger slot, validates the returned base64 template against the reported device limits, and immediately submits it to `FingerPrint/SetUp` for reader 1. A 2xx response is not assumed to mean reader success: `FingerPrintStatus.StatusList.cardReaderRecvStatus` must report `1` when present.

The fingerprint template exists only in bridge process memory and the two LAN requests. It is not written to the local queue, logs, Firestore command/result documents, or dashboard. Only employee number, finger slot, terminal-reported quality, state, and a bounded safe error are retained.

## Authentication and transport

ISAPI uses HTTP Digest authentication. The client supports challenge parsing, nonce counts, `qop=auth`, cached challenge reuse, and stale challenge replacement. Credentials are never included in URLs or logs. HTTP is accepted on the trusted local LAN because many terminals do not provide a manageable TLS certificate; use terminal HTTPS where its firmware and certificate operations are supportable.

Do not forward the terminal management port through the public internet. Segment the terminal/bridge PC according to customer network policy.

## Event identity and time

Normalized evidence retains device ID/serial, event serial, employee number/name, event instant, major/minor codes, attendance status, verify mode, card/reader/door fields, receipt time, and original raw data.

The deterministic SHA-256 ID uses stable source fields so poll overlap and restart retrieval produce the same ID. The configured IANA timezone is used when firmware returns a local timestamp without a trustworthy offset. The terminal clock, timezone, and NTP state must be checked during installation.

Polling always overlaps the prior checkpoint by the configured number of seconds. A first run uses the initial lookback window. The bridge writes valid events and malformed-entry evidence before atomically replacing `checkpoint.txt`.

## Diagnostics

```powershell
hikbridge.exe test-device --config <path>
hikbridge.exe test-users --config <path>
hikbridge.exe test-events --config <path> --minutes 10
hikbridge.exe test-events --config <path> --minutes 10 --raw
```

`test-device` reports model, serial, firmware, device time, timezone, and time mode. `test-users` validates user search and reports enrollment summary. `test-events` validates the actual event shape. Raw output is opt-in because it may contain personal data.

## Fixture coverage

Automated tests cover:

- Digest challenge/cached authorization;
- device metadata;
- multi-page JSON events;
- missing optional fields;
- malformed timestamps with raw preservation;
- event identity stability;
- device response size/error handling.
- employee create/update endpoint selection;
- XML fingerprint capture parsing and base64 bounds;
- reader-level fingerprint setup failures returned inside HTTP 200;
- durable, acknowledged command results without biometric data.

Add a sanitized fixture whenever a supported firmware produces a materially different response. Remove names, employee numbers, card values, serials, IPs, and credentials before committing it.

## Failure behavior

- Unreachable terminal, invalid password, timeout, or retryable HTTP error updates local status/logs but does not stop the service or cloud loop.
- A successful later poll clears the device error and retries metadata discovery when model information was previously unavailable.
- Cloud health reports mark the terminal offline while continuing to report the bridge itself as reachable.
- Unexpected/malformed entries are retained under `events\failed`; valid entries in the same response continue through the queue.
