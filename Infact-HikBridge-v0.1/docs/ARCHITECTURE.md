# Architecture

## System purpose

Infact HikBridge is an offline-first attendance evidence pipeline plus a cloud attendance application. It is split at a deliberate trust boundary: a customer-site Windows service talks to the terminal and holds only a per-device bridge credential; Firebase owns tenant identity, immutable evidence, business rules, derived attendance, and browser authorization.

```text
Customer LAN                                      Infact cloud

Fingerprint -> Hikvision terminal                 Firebase Authentication
                    |                                      |
              Digest ISAPI                                users
                    |                                      |
             HikBridge Service -- HMAC/HTTPS --> ingestion Function
                    |                                      |
        checkpoint + durable queue                 Secret Manager + replay
                                                           |
                                                  immutable raw events
                                                           |
                                            identity mapping / recalculation
                                                           |
                                                  attendance-day projections
                                                           |
                                             Next.js operations dashboard
```

## Windows bridge

`cmd/hikbridge` is both the interactive CLI and Windows Service executable. `internal/bridge.Runner` owns three independent loops:

- device polling reads overlapping ISAPI windows and advances the checkpoint only after every valid or malformed record is durable;
- cloud synchronization sends pending batches with bounded exponential backoff and event-specific acknowledgement;
- maintenance removes only cloud-acknowledged local records after the configured retention period.

Signed device-health probes run on the cloud loop without blocking polling. Status, setup, and diagnostics bind to loopback. Logs are structured and rotated. Windows Service Control Manager owns automatic startup and recovery.

The file-backed store isolates every event in a versioned record. States are `pending`, `uploading`, `synced`, and `failed`. Startup converts interrupted uploads back to pending, detects already-synced duplicates, and quarantines corrupt source bytes. Deterministic IDs and poll overlap make repeated retrieval safe.

## Cloud ingestion

`hikbridgeV1Events` is a public HTTP endpoint because a customer bridge has no Firebase user token. Public reachability does not grant trust: every request is bounded, timestamped, nonce-bearing, and signed with a per-device HMAC key stored only in Secret Manager.

The global server-only device registry resolves a version-1 device ID to exactly one organization/branch and active Secret Manager versions. Firestore transaction create semantics make raw event documents idempotent. A short-lived replay document distinguishes an identical retry from nonce reuse with changed content.

Signed health probes update the tenant device projection with bridge last-seen, terminal connectivity, last successful device poll, queue count, bridge version, model, serial, and firmware. No private LAN address is sent.

## Attendance domain

Raw `attendanceEvents` never change. `attendanceDays` are replaceable, versioned projections computed from:

- organization timezone;
- effective-dated shift assignment and shift policy;
- mapped raw punches;
- branch/global holiday;
- approved leave;
- immutable approved manual adjustments.

The pure calculation engine handles explicit or inferred IN/OUT, duplicate/multiple/one punches, overnight shifts, configurable grace interpretation, early leave, break deduction, overtime thresholds/rounding, holidays, leave, rest days, missing punches, and DST boundaries. Every automatic, manual, and batch path calls the same repeat-safe recalculation service.

## Tenant and authorization model

Tenant data lives below `organizations/{organizationId}`. Firebase Authentication identifies users, membership documents assign active roles, Firestore Rules enforce tenant reads/direct writes, and callable Functions repeat authorization for audited operations. Browser role hiding is convenience only.

Server-only top-level collections are denied to every browser. The dashboard never receives bridge credentials or Firebase Admin material. High-impact mutations—device lifecycle, identity mapping, corrections, shifts, and assignments—use callable Functions with strict schemas and audit records.

## Dashboard

`web/` is a Next.js App Router client application using Firebase modular SDKs. Repository queries remain on organization paths and have explicit result caps. Operational pages surface attendance exceptions, unmapped identities, missing punches, device status, and recalculation state without exposing stack traces or secrets.

A health report is expected every 60 seconds. Stored offline status is honored immediately; five minutes without any bridge contact is treated as offline in the dashboard so a stopped service does not remain falsely green.

## Reliability invariants

1. The polling checkpoint never advances past evidence that was not durably handled.
2. Cloud failure never stops device polling or deletes pending evidence.
3. Only IDs explicitly accepted or identified as duplicates become synced.
4. Raw Firestore events are created once and never corrected in place.
5. Every browser path is tenant scoped and server-side workflows authorize again.
6. Recalculation may repeat without accumulating business effects.
7. Secrets are not logged, returned after storage, embedded in the installer, or placed in browser-readable documents.

## Deployment units

- `Infact-HikBridge-Setup-<version>.exe`: versioned Windows installer and local setup workflow.
- Firebase Functions: ingestion, provisioning, identity, shifts, corrections, triggers, and scheduled jobs.
- Firestore Rules/indexes/TTL: authorization and query/cleanup support.
- Next.js dashboard: separately configured production build with Firebase web configuration.

The release process must deploy and validate these units against a staging project before a customer rollout; see `PRODUCTION_READINESS.md`.
