# Technical Debt and Release Gates

Updated: 2026-08-24

Priorities are P0 (release blocker), P1 (required before a production pilot), P2 (important hardening), and P3 (future improvement). This register describes the repository after completion of the local implementation and automated verification milestones.

## Current verdict

There are no known open P0 code defects. The project is not yet approved for production because the P1 external-validation gates below require customer hardware, a clean elevated Windows environment, or a real Firebase staging project.

## P1 — Required before a production pilot

### Verify the target Hikvision terminal and firmware

Run the documented diagnostics against the actual DS-K1A8503EF and capture sanitized fixtures. Confirm its Digest challenge, event and user endpoint shapes, pagination behavior, event codes, fingerprint metadata, device timezone, clock behavior, reboot recovery, and password-failure response. The repository fixtures exercise the supported adapter shapes but cannot establish the installed firmware's behavior.

### Complete clean-Windows lifecycle validation

On a clean supported Windows VM, install, upgrade, reboot, stop/start/restart, repair, and uninstall the signed release candidate. Verify LocalService permissions, ProgramData ACLs, service recovery, setup-loopback binding, port collision behavior, log rotation, queue preservation, and removal/preservation choices. Run the race detector in a Windows toolchain with GCC; the current build host has no C compiler.

### Validate a staging Firebase deployment

Deploy to a non-production Firebase project and verify Secret Manager IAM, credential provisioning and rotation, Functions concurrency/timeouts, Firestore indexes, rules, replay protection, quotas, billing alerts, retention/TTL policies, structured logs, and backup/restore procedures. Emulator success does not validate cloud IAM or service configuration.

### Sign and distribute release artifacts

Authenticode-sign the bridge executable and Inno Setup installer with the organization's code-signing certificate. Publish the SHA-256 digest and verify SmartScreen/install behavior. The locally built artifacts are intentionally unsigned.

## P2 — Important hardening

- Firebase production dependencies currently report eight moderate transitive `uuid` advisories through Firebase Admin's Firestore/Storage dependency tree. `npm audit` proposes a forced downgrade to an incompatible major version, so no unsafe automatic fix was applied. Re-evaluate after Firebase publishes a compatible dependency update.
- Bridge credentials are protected by ProgramData ACLs but remain decryptable by principals that can read the service configuration. Evaluate DPAPI or Windows Credential Manager after operational recovery and rotation requirements are agreed.
- The file-backed queue is appropriate for the current volume, but should be load-tested with the customer's worst-case offline backlog. Reconsider SQLite if file count, antivirus interaction, or support tooling becomes problematic.
- Add scheduled cross-platform and Windows CI, including installer compilation, emulator tests, and the Go race detector on a C-enabled runner.
- Add cloud monitoring for ingestion rejection rate, replay failures, recalculation poison jobs, stale devices, queue backlog, and Secret Manager access failures.
- Confirm and configure production retention policies for immutable raw events, audit trails, derived attendance, replay claims, and bridge archives with the customer's compliance owner.

## P3 — Future improvements

- Add asynchronous report jobs for exports beyond the interactive 31-day/5,000-row limits.
- Add organization-level diagnostic history and operator-visible bridge version rollout reporting.
- Consider a signed remote configuration/update channel after ownership, rollback, and certificate policies are defined.
- Add schema migration tooling before changing normalized event or checkpoint versions.

## Closed findings

The implementation closed the original code-level findings for Windows-safe checkpoint replacement, event-specific acknowledgements, independent poll/upload loops, parse-error evidence, file durability and quarantine, bounded retry/jitter, HMAC replay protection, tenant isolation, Secret Manager rotation, deterministic ingestion, immutable evidence, idempotent recalculation, overnight/DST handling, bounded queries, localhost setup security, service lifecycle/recovery, rotating logs, archive retention, bounded secret caching, signed device health, and stale-device inference.

Their automated coverage is recorded in `PRODUCTION_READINESS.md`; the remaining P1 items above must not be represented as passed until executed in their real environments.

