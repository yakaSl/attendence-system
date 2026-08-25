# Decision Log

## 2026-08-23 — Execute the prompt set as dependency-ordered milestones

Problem:

The 21 prompts overlap heavily and later phases depend on contracts created in earlier phases. Running them as independent greenfield tasks would repeat discovery and risk incompatible implementations.

Decision:

Preserve the phase gates but execute related work in dependency-ordered milestones, with the repository documentation and automated tests acting as the persistent context.

Reason:

This reduces repeated repository reads and explanations while keeping audit, implementation, and review boundaries visible.

Alternatives considered:

- Execute every prompt literally and independently.
- Generate the full monorepo in one pass.

Consequences:

Progress reports will reference milestone and prompt numbers. A later milestone will not start until its shared contracts and test gate are stable.

## 2026-08-23 — Retain the file-backed event store for the first hardening pass

Problem:

The current file queue has correctness and operational gaps, while Prompt 03 permits either hardening it or migrating to SQLite.

Decision:

Repair and test the existing file-backed design first. Reconsider SQLite only after requirements or measurements show that per-file records cannot meet reliability and supportability needs.

Reason:

The file-per-event model already provides simple event-level isolation and deterministic deduplication with no added runtime dependency. Its current critical problems have focused fixes.

Alternatives considered:

- Migrate immediately to SQLite.
- Replace the store with an append-only JSON log.

Consequences:

The hardening work must add Windows-safe replacement, explicit attempt metadata/state, corrupt-record isolation, durability checks, and bounded archive behavior. If this becomes more complex than a transactional SQLite implementation, the decision will be revisited before production.

## 2026-08-23 — Version and freeze the bridge ingestion acknowledgement

Problem:

An HTTP 2xx status alone cannot safely tell the bridge which events were stored, duplicated, or rejected. The bridge and Firebase implementation also need one authentication contract to avoid incompatible phase-specific schemes.

Decision:

Use ingestion protocol version 1 documented in `INGESTION_PROTOCOL.md`. Sign a canonical string containing version, device, timestamp, nonce, and the exact-body SHA-256 digest. Require the response to classify every submitted event ID exactly once as accepted, duplicate, or rejected.

Reason:

The timestamp and nonce support replay controls; the body digest prevents alteration; the device identity prevents cross-device use; and event-specific acknowledgement prevents local evidence from being marked synced after only partial acceptance.

Alternatives considered:

- Retain the original `timestamp.body` signature and status-only acknowledgement.
- Install Firebase Admin credentials on the bridge.
- Use OAuth device authorization in version 1.

Consequences:

The Firebase endpoint must implement this exact canonicalization and response validation. Secret rotation may require a future key-ID header, but version 1 credentials remain per-device and can be replaced through provisioning.

## 2026-08-23 — Nest tenant data and keep bridge credentials server-only

Problem:

Tenant authorization must be provable from document paths, while bridge device identifiers must remain globally unambiguous and credential material must never be browser-readable.

Decision:

Store operational tenant data below `organizations/{organizationId}`. Reserve each version 1 bridge `deviceId` globally in the server-only `bridgeDeviceRegistry`, keep replay claims in `_bridgeReplay`, and store credential values only in Google Secret Manager. Firestore retains secret version names, not keys. Provisioning returns a newly generated key exactly once.

Reason:

Organization-scoped paths make security rules and collection ownership explicit. A global device reservation prevents one physical bridge identity from resolving to two tenants. Secret Manager provides access controls, versioning, and rotation without exposing verification keys to Firebase clients.

Alternatives considered:

- Put organization IDs only in fields on top-level operational documents.
- Store HMAC keys in public device documents.
- Permit device IDs to repeat between organizations.

Consequences:

Version 1 device IDs are globally unique. Credential rotation accepts the current and previous secret version for a 15-minute overlap, and operators must capture the returned credential during provisioning or rotate it again.

## 2026-08-23 — Calculate attendance from immutable evidence

Problem:

Late device uploads, identity remapping, policy changes, and HR corrections can all change a historical attendance result. Updating raw device events would destroy the evidence required to explain or repeat those changes.

Decision:

Keep `attendanceEvents` immutable and derive replaceable `attendanceDays` with calculation version `attendance-v1`. Use IANA time zones and Temporal instants for shift boundaries. Store historical shift assignments as effective-date records. Store approved corrections and their before/after audits separately, then run every path through the same idempotent `recalculateAttendance(organizationId, employeeId, date)` service.

Reason:

This makes delayed events and policy changes replayable, handles overnight and daylight-saving boundaries without fixed-offset assumptions, and leaves an auditable line from source events and adjustments to each result.

Alternatives considered:

- Mutate or synthesize raw punches after HR corrections.
- Calculate attendance only in the browser.
- Store only the employee's current shift.

Consequences:

Derived days may change when new evidence or approved policy data arrives. Consumers must display manual-adjustment and exception indicators, and bulk remapping is processed as cursor-based background work.

## 2026-08-23 — Use browser-scoped reads and audited callable mutations

Problem:

The operations dashboard needs responsive tenant data while sensitive actions such as shift policy changes, corrections, identity mapping, and credential lifecycle require validation, audit, and recalculation that Firestore Rules alone cannot perform.

Decision:

Use the modular Firebase browser SDK for tenant-path reads constrained by Security Rules. Route high-impact mutations through authenticated callable Functions that repeat role authorization, validate strict schemas, create audit records, and enqueue derived-data work. Keep report queries bounded to 31 days and 5,000 derived rows in the interactive application.

Reason:

Direct reads retain realtime-capable client performance and avoid a redundant API layer for ordinary views. Callables provide one controlled mutation boundary for workflows with side effects or secrets. Explicit query caps prevent the first reporting implementation from downloading an organization database into a browser.

Alternatives considered:

- Put Firebase Admin credentials in the Next.js browser bundle.
- Allow every HR mutation directly through the Firestore browser SDK.
- Proxy every read through Next.js server routes.

Consequences:

Firestore Rules remain mandatory even when controls are hidden by role. Production user profiles must identify a default organization. Larger exports require asynchronous server report jobs, and deployment environments must provide Firebase web configuration without adding service-account material to the client.


## 2026-08-24 — Use a loopback setup application inside the signed installer

Problem:

Customer technicians need to configure device and cloud credentials without editing JSON, but a desktop framework would add a large runtime and a remotely reachable setup page would expose local secrets.

Decision:

Package the bridge with Inno Setup and launch its setup mode as an elevated, loopback-only HTTP application. Protect setup with a one-time bootstrap token, HttpOnly SameSite cookie, exact Host and Origin checks, CSRF tokens, restrictive CSP headers, redacted reads, atomic configuration writes, and ProgramData ACLs.

Reason:

This reuses the small Go runtime, works during an offline Windows installation, and keeps the credential surface local and short-lived while still providing a guided UI.

Consequences:

The setup process must never bind to a non-loopback address or return stored secrets. A clean elevated Windows VM remains a release gate for UAC, ACL, port-collision, upgrade, and uninstall behavior.

## 2026-08-24 — Treat bridge health as signed operational data

Problem:

An ingestion success alone cannot distinguish an idle healthy terminal from a disconnected terminal, and a dashboard can display stale online state indefinitely after a bridge stops.

Decision:

Send bridge status through the same versioned HMAC request as attendance events. Project last contact, device metadata, terminal connectivity, last successful poll, and queue depth into the tenant device record. In the dashboard, infer offline after six minutes without contact while preserving an explicit disabled state.

Reason:

The existing authenticated channel avoids a second credential protocol, makes health updates tenant-safe, and gives operators useful evidence without exposing bridge secrets or local logs.

Consequences:

Secret resolution is cached by immutable Secret Manager version with a five-minute TTL and a 500-entry bound. Synced bridge evidence is retained locally for a configurable period (90 days by default) so heartbeat and queue operations remain bounded.
