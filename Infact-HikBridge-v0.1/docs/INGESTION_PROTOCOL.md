# HikBridge Ingestion Protocol v1

Status: contract frozen for bridge/backend implementation

## Transport

Production requests use HTTPS POST to the configured ingestion endpoint. Plain HTTP is rejected unless `cloud.allowInsecureHttp=true` and the endpoint host is loopback (`localhost`, `127.0.0.0/8`, or `::1`).

No Firebase Admin credential is installed on the customer PC. Each registered device receives an independent high-entropy bridge secret.

## Headers

```text
Content-Type: application/json
X-HikBridge-Version: 1
X-HikBridge-Device: <local device ID>
X-HikBridge-Timestamp: <Unix seconds>
X-HikBridge-Nonce: <32 lowercase hexadecimal characters>
X-HikBridge-Signature: <64 lowercase hexadecimal characters>
```

The body repeats the device ID and request ID (nonce) so validation can reject proxy/header mix-ups.

## Signature

The bridge calculates the lowercase SHA-256 digest of the exact HTTP body bytes. It then joins these UTF-8 strings with a single LF byte and no trailing LF:

```text
hikbridge-hmac-sha256
1
<device ID>
<Unix timestamp>
<nonce>
<lowercase SHA-256 hex of exact body>
```

`X-HikBridge-Signature` is lowercase hexadecimal HMAC-SHA256 of that canonical string using the device's bridge secret.

Contract vector:

```text
key       = 0123456789abcdef0123456789abcdef
device    = office-main-01
timestamp = 1787494635
nonce     = 00112233445566778899aabbccddeeff
body      = {"deviceId":"office-main-01","events":[]}
signature = 37e87a76af464598fe05713fa85b7b75de949e865c5ef82947a6329d9d0506c7
```

The backend must compare decoded signature bytes with a timing-safe function, enforce a short timestamp skew window, and retain nonce/replay records for at least that window. A nonce may be repeated only as an idempotent retry of the identical signed body; a nonce reused with different bytes must be rejected.

## Event request

```json
{
  "protocolVersion": "1",
  "requestId": "00112233445566778899aabbccddeeff",
  "deviceId": "office-main-01",
  "events": [
    {
      "id": "64-character-deterministic-event-id",
      "deviceId": "office-main-01",
      "deviceSerial": "...",
      "serialNo": 4101,
      "employeeNo": "17",
      "name": "Kasun Perera",
      "eventTime": "2026-08-23T08:47:13+05:30",
      "major": 5,
      "minor": 75,
      "attendanceStatus": "checkIn",
      "currentVerifyMode": "fingerPrint",
      "raw": {},
      "receivedAt": "2026-08-23T03:17:14Z"
    }
  ]
}
```

Batch size is 1–100. The backend must also enforce an HTTP body limit and a per-event raw-payload limit.

## Probe request

`test-cloud` sends the same authenticated request with `"probe": true` and an empty `events` array. A probe authenticates and resolves provisioning without creating attendance events.

The running bridge sends the same probe periodically with a bounded status object:

```json
{
  "protocolVersion": "1",
  "requestId": "00112233445566778899aabbccddeeff",
  "deviceId": "office-main-01",
  "probe": true,
  "status": {
    "deviceConnected": false,
    "lastSuccessfulDevicePoll": "2026-08-23T03:15:00Z",
    "pendingEvents": 7,
    "deviceModel": "DS-K1A8503EF",
    "deviceSerial": "...",
    "firmwareVersion": "V3.3.0"
  },
  "events": []
}
```

Status is accepted only on a probe. Text fields are capped at 128 characters and the pending count at 1,000,000. It does not contain errors, credentials, employee data, or LAN addresses. A status probe updates the public tenant device projection; omission remains valid for interactive `test-cloud` compatibility.

The running bridge also uses a probe as a bidirectional command exchange. Only that loop sets `acceptCommands`; interactive cloud tests and ordinary status probes cannot lease work. Completed results are retained locally until their IDs are acknowledged:

```json
{
  "protocolVersion": "1",
  "requestId": "00112233445566778899aabbccddeeff",
  "deviceId": "office-main-01",
  "probe": true,
  "acceptCommands": true,
  "commandResults": [
    {
      "commandId": "command-id",
      "state": "succeeded",
      "output": { "employeeNo": "EMP-17", "fingerPrintId": 2, "quality": 88 }
    }
  ],
  "events": []
}
```

The cloud may respond with at most one leased terminal command. Supported types are `upsert_user` and `enroll_fingerprint`. An enrollment command contains employee identity fields and a finger slot only. It never contains `fingerData` or another biometric template. The bridge captures the template from the local terminal, sends it immediately back to that terminal, and reports only terminal status, finger slot, and quality.

## Success response

The response accounts for every submitted event exactly once by ID:

```json
{
  "protocolVersion": "1",
  "requestId": "00112233445566778899aabbccddeeff",
  "deviceId": "office-main-01",
  "organizationId": "org_abc",
  "branchId": "branch_colombo",
  "accepted": ["event-id-1"],
  "duplicates": ["event-id-2"],
  "rejected": [
    {
      "id": "event-id-3",
      "code": "invalid_event",
      "message": "eventTime is outside the accepted range"
    }
  ],
  "commands": [],
  "acknowledgedCommandIds": []
}
```

The bridge marks only `accepted` and `duplicates` records synced. Rejected records move to retained local failed storage with their error. Missing, unknown, or repeated IDs make the entire acknowledgement invalid and leave the batch retryable.

A probe response contains no event results and must include the resolved `organizationId`.

Command delivery uses a short Firestore lease and a per-terminal fingerprint lock. Before touching the terminal, the bridge durably writes a fail-safe interrupted receipt, then atomically replaces it with the final bounded result metadata. A process failure therefore reports an interrupted attempt instead of silently prompting for another capture. Results remain until cloud acknowledgement. A terminal command expires server-side and client-side; terminal results are idempotently accepted after an ambiguous response.

## Error response

Non-2xx errors are machine-readable and never echo secrets, signatures, or authorization material:

```json
{
  "error": {
    "code": "invalid_signature",
    "message": "Request authentication failed"
  }
}
```

Recommended codes include `unsupported_version`, `invalid_headers`, `stale_request`, `replay_conflict`, `invalid_signature`, `device_not_found`, `device_disabled`, `cross_device_event`, `body_too_large`, `batch_too_large`, and `invalid_request`.

## Idempotency

Firestore raw-event document IDs are derived from the tenant-scoped device plus the bridge's deterministic event ID. The backend uses create/precondition semantics or a transaction, never a query-before-insert race. A timeout after a successful write is safe: retry returns that event ID in `duplicates`, allowing the bridge to mark it synced.
