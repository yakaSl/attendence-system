# Development Plan

Updated: 2026-08-24

## Token-efficient execution strategy

The supplied 21 prompts form one dependency graph rather than 21 independent greenfield tasks. They were executed as shared milestones to avoid repeated repository discovery and incompatible contracts:

1. Keep architecture, debt, decisions, and this plan as compact persistent context.
2. Search for callers and read only files involved in the active milestone.
3. Freeze cross-layer contracts once: event identity, ingestion acknowledgement, Firestore paths and roles, attendance inputs/outputs, and provisioning/rotation.
4. Add fixture-driven or table-driven tests with each behavior so later phases can validate by running tests instead of re-analyzing implementations.
5. Use focused gates during implementation and one reproducible full gate at the end.
6. Keep physical-device, elevated-VM, and deployed-cloud checks explicitly manual when those environments are unavailable.

## Prompt mapping and completion

### Milestone A — Baseline audit (Prompt 01)

Completed. Captured the original architecture, technical debt, dependency plan, and decision log before structural changes.

### Milestone B — Production-capable HikBridge core (Prompts 02–04, 07, and bridge portions of 16)

Completed locally. Added fixture-tested Digest/ISAPI handling, pagination defenses, deterministic event evidence, Windows-safe durable storage, quarantine and retry metadata, independent polling/upload loops, strict configuration, versioned signed ingestion, event-specific acknowledgement, diagnostics, Windows service lifecycle/recovery, rotating logs, health reporting, and bounded archive retention.

Manual gates: target-device firmware validation, race detector on a C-enabled runner, and elevated service lifecycle testing on clean Windows.

### Milestone C — Firebase foundation (Prompts 05, 06, 08, 10, 15, and Firebase portions of 16)

Completed locally. Added the TypeScript Functions workspace, tenant schema/rules/indexes, versioned HMAC/replay validation, deterministic idempotent writes, server-only provisioning and rotation, Secret Manager caching, signed device-health projection, audit boundaries, and emulator coverage.

Manual gate: deploy and validate IAM, Secret Manager, indexes, retention, quotas, and operations in a staging Firebase project.

### Milestone D — Attendance domain (Prompts 09, 12 domain model, 14, and processing portions of 16)

Completed locally. Added Temporal-based pure calculation, configurable grace modes, punch pairing, overnight and DST behavior, overtime, missing-punch policy, historical shifts, leave/holidays, immutable adjustments, idempotent recalculation, cursor jobs, bounded reads, poison-job handling, and source-change triggers.

### Milestone E — Operational dashboard (Prompts 11–14 UI and dashboard portions of 16)

Completed locally. Added authenticated tenant-scoped routes for login, dashboard, employees, attendance, shifts, devices, reports, corrections, and settings; role-aware callable mutations; bounded reports; live/demo repositories; responsive operations UI; exception visibility; and stale-device inference.

### Milestone F — Packaging and local setup (Prompts 17 and 18)

Completed locally. Added UAC elevation, Inno Setup packaging, secure ProgramData layout, localhost-only one-time setup, Origin/Host/CSRF/CSP protections, redacted state, device/cloud tests, atomic save, service installation/restart, and operator documentation.

Manual gate: signed clean-VM installation, upgrade, reboot, repair, and uninstall validation.

### Milestone G — End-to-end and production review (Prompts 19 and 20)

Completed for repository-controlled checks. Normal and failure paths are covered through Go tests, Cloud unit tests, Firestore emulator integration, web tests/build, setup smoke checks, and installer compilation. Code-level P0/P1 findings discovered during review were fixed. External P1 gates remain open and are listed in `PRODUCTION_READINESS.md` and `TECHNICAL_DEBT.md`.

### Milestone H — Documentation consolidation (Prompt 21)

Completed. The root README and focused architecture, Hikvision, Firebase, schema, security, service, installation, setup, troubleshooting, end-to-end, and readiness documents describe the implemented system and explicitly distinguish automated evidence from manual gates.

## Frozen contracts

1. Normalized event identity and immutable evidence format.
2. Version 1 HMAC canonical request and event-specific response.
3. Organization-scoped Firestore paths, roles, rules, and indexes.
4. Attendance policy inputs, Temporal boundary rules, and derived outputs.
5. One-time provisioning plus current/previous Secret Manager rotation.
6. Signed device-health payload and five-minute dashboard staleness rule.

## Release path

Run `scripts/verify.ps1 -Full -BuildInstaller` for the repository gate, then execute the hardware, clean-Windows, staging Firebase, and code-signing P1 gates. Production approval can be considered only after all four are evidenced and the P2 dependency advisory is accepted or remediated.

