# Production Readiness Review

Review date: 2026-08-24  
Target: Infact HikBridge 0.1.0  
Verdict: **not yet approved for production distribution**

The repository passes its automated code/build/emulator gates, and code-level P0/P1 findings discovered during this review were fixed. Production approval remains blocked by external release evidence that cannot be completed without the actual terminal, staging Firebase project, clean Windows VM, IAM/TTL configuration, and signing identity.

## Severity definition

- **P0** — active data-loss, cross-tenant, secret-compromise, or system-wide release blocker.
- **P1** — must be fixed or evidenced before production.
- **P2** — should be scheduled; acceptable only with an explicit owner/mitigation.
- **P3** — future improvement.

## Open release gates

### P0

None known after the automated audit and fixes below.

### P1 — must close before production

| Finding | Required closure evidence |
|---|---|
| Physical DS-K1A8503EF firmware compatibility is not tested in this workspace | Execute every relevant physical-device case in `END_TO_END_TEST_PLAN.md`; retain sanitized evidence and firmware/version matrix. |
| Installer/service lifecycle is not tested on a clean supported Windows VM | Fresh install, UAC setup, ACL check, automatic start/recovery, upgrade with pending data, and uninstall/retention sign-off. |
| No staging Firebase deployment or real Auth/Functions/Secret Manager end-to-end run was authorized | Deploy to staging, validate callable roles, HMAC ingestion, triggers/scheduler, indexes, quotas, and dashboard with `NEXT_PUBLIC_DEMO_MODE=false`. |
| Firestore TTL is repository-documented but cannot be enabled by source files alone | Enable TTL for `_bridgeReplay.expiresAt` in every deployed project and record configuration evidence. |
| Runtime IAM, budgets, alerts, backups/retention, and incident contacts are environment-owned | Review least privilege for Functions/Secret Manager, enable billing budgets and error/queue/offline alerts, document restore/export and incident ownership. |
| Windows release artifacts are unsigned test builds | Sign installer and executable with the production certificate, timestamp them, publish SHA-256, and verify SmartScreen/enterprise deployment behavior. |
| Go race detector could not run because this workstation has no C compiler | Run `go test -race ./internal/...` in release CI with a supported compiler and archive the result. |

Do not label the product production-ready until every row is closed.

## Code-level findings fixed in this review

| Severity | Finding | Resolution |
|---|---|---|
| P0 | Checkpoint replacement was not Windows-safe | Sibling temp file, flush, `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)`, repeated replacement tests. |
| P0 | HTTP success could mark a whole batch synced without per-event proof | Protocol v1 requires every ID exactly once in accepted/duplicate/rejected; invalid acknowledgements remain pending. |
| P0 | Cloud latency/failure could block device polling | Independent polling and cloud loops with bounded backoff/jitter; automated slow/failing cloud tests. |
| P0 | Malformed terminal entries could be skipped by advancing the checkpoint | Raw malformed evidence is preserved before checkpoint advancement while valid siblings continue. |
| P1 | Interrupted uploads/corrupt queue records lacked explicit recovery | Versioned states, upload recovery, failed quarantine with source bytes, deterministic deduplication. |
| P1 | Offline/idle/stopped devices were not distinguishable in the dashboard | Signed 60-second bridge health reports, terminal status/queue/metadata projection, and five-minute stale-contact inference. |
| P1 | Secret Manager was read on every batch | Concurrent-deduplicated, 5-minute, 500-entry version-name cache; rotation fetches a new version immediately. |
| P1 | Cloud-acknowledged local files could grow without bound | Configurable synced-record retention, default 90 days; pending/failed evidence is never automatically pruned. |
| P1 | Date-range source-trigger retries could reset an already-progressing job | Deterministic create-if-absent transaction for leave/holiday jobs. |
| P1 | A poison recalculation job could remain pending and starve work | Jobs become failed after five unsuccessful processing attempts while preserving diagnostics. |
| P1 | Recalculation queries could silently become unbounded/ambiguous | Explicit punch/adjustment safety limits, deterministic history ordering, and required indexes. |
| P1 | Local browser setup could expose configuration or bind beyond the PC | Explicit `127.0.0.1`, one-time token/session, Host/Origin/CSRF checks, CSP, secret-presence-only responses, atomic save, ACL enforcement, UAC. |
| P1 | Installer build could discover Go packages inside Node dependencies | Build/verification scripts target only project Go package roots. |

## Component review

### HikBridge / Windows

- Polling, synchronization, and maintenance goroutines have cancellation paths and are joined before exit. The status HTTP server has read/header/write/idle timeouts and graceful shutdown.
- Device/cloud HTTP response bodies are bounded and closed. Retries are bounded; cloud backoff is jittered from 5 seconds through 5 minutes. Polling never waits for cloud.
- Event/checkpoint writes are atomic and locally serialized. Ambiguous cloud outcomes are safe through deterministic IDs and acknowledgements.
- Logs rotate. Synced archive retention is bounded; failed evidence remains an operational capacity concern to monitor.
- Service recovery has three escalating restarts and does not crash on ordinary device/cloud authentication/connectivity errors.
- Installer sources contain no customer secret. Uninstall retaining ProgramData is deliberate.

### Firebase / SaaS

- Tenant browser paths are nested under organizations; Rules default deny and server-only registry/replay/credential paths deny all clients.
- Callable Functions authenticate and repeat organization role authorization. Raw events, derived days, device status, credentials, and audits are server-write-only.
- HMAC validates exact bytes, version/device/timestamp/nonce/body hash, with constant-time comparison, five-minute skew, transactional replay claim, and per-device Secret Manager versions.
- Ingestion request/body/event bounds and `maxInstances`/concurrency are explicit. Firestore event writes are deterministic and transactionally deduplicated.
- Recalculation worker is single-instance, cursor-based, bounded, repeat-safe, and quarantines persistent failures.
- Interactive browser queries are tenant-scoped and capped; this is suitable for the documented initial operating envelope, not unbounded enterprise reporting.

### Attendance engine

- Organization timezone and Temporal zoned instants own date boundaries; fixed host offsets are not used.
- Overnight shifts, grace interpretations, multiple/duplicate/missing/typed/untyped punches, holidays, leave, rest/no-shift, early/late/OT, DST, late arrival, and manual corrections have deterministic unit coverage.
- Raw events remain immutable; source IDs, adjustment IDs, exceptions, and calculation version remain on derived output.
- Historical effective-date assignments and date-range recalculation cover shift/policy changes. Punch and correction safety limits fail loudly instead of silently producing partial results.

### Dashboard

- Firebase user plus active organization membership establishes UI context; Rules/callables are enforcement.
- No Admin SDK or secret material exists in the browser. Device credential is displayed only in the provisioning/rotation response.
- Loading/error/empty states are present; normal users receive operational messages rather than server stack traces.
- Attendance ranges cap at 5,000 rows and reports at 31 days. Employee/assignment/device/reference reads also have explicit caps.
- Offline status uses signed current state plus stale-contact inference; direct secret and raw-write paths are absent.

## P2 backlog

| Finding | Mitigation / next action |
|---|---|
| Device/HMAC secrets are plaintext inside an Administrator/System-only config file | ACL is enforced and setup never returns secrets. Evaluate DPAPI or Windows Credential Manager after installer/field support testing. |
| `npm audit --omit=dev` reports 8 moderate `uuid` issues through current Firebase Admin storage/firestore dependencies | The vulnerable buffer-supplied UUID API is not called directly and npm offers only a breaking forced downgrade. Track upstream and upgrade when Firebase publishes a compatible tree. Dashboard production audit is clean. |
| Browser reports and roster reads have initial-product caps rather than cursor UI/server exports | Show cap semantics and implement async server report jobs/pagination before customers exceed the documented envelope. |
| Failed local evidence has no automatic retention | Alert on failed count/disk space and define support/export disposition; never auto-delete before policy approval. |
| Provisioning failure can reserve a device ID and require operator recovery | Add an authenticated retry/cleanup workflow that reconciles partially created Secret Manager resources. |
| Branch-scoped memberships are modeled but not enforced | Do not promise branch-limited access until Rules, callables, queries, and tests implement it together. |
| Local setup refuses to open an invalid/corrupt existing config | Support can move the corrupt file after preserving it; add an explicit repair/quarantine workflow later. |
| Terminal HTTP may be required for models without manageable TLS | Keep traffic on the trusted segmented LAN; prefer supported HTTPS and document certificate operations per firmware. |

## P3 backlog

- Re-evaluate file-per-event storage versus SQLite after measured queue volume/support experience.
- Introduce an opaque registration ID if human-friendly device IDs must repeat across organizations.
- Add platform-admin diagnostics and cross-tenant operational tooling with explicit audited authorization.
- Add CI-produced SBOM/provenance and automated installer signature verification.

## Verification record

The latest workspace pass completed:

- Go format, targeted tests, vet, and Windows versioned build;
- Cloud lint, typecheck, 28 unit tests, build;
- Firestore Rules: 6 tests; Firestore repository/recalculation: 6 emulator tests;
- Dashboard lint, typecheck, 4 tests, production build, and HTTP route smoke checks;
- local setup HTTP/security smoke check;
- Inno Setup 6.7.3 compilation of `Infact-HikBridge-Setup-0.1.0.exe`.

On 2026-08-24, the final workspace run of `scripts\verify.ps1 -Full -BuildInstaller` completed successfully with Java 21 and rebuilt both version 0.1.0 artifacts. The Go race stage was explicitly skipped because this workstation has no C compiler and remains a P1 release-CI gate. Attach the verification output, signed-artifact hashes, and the external gate evidence to the production release record.
