# End-to-End Test Plan

## Purpose and environment

This plan verifies the evidence chain from a physical fingerprint punch to a tenant-authorized dashboard result, then proves that expected failures do not lose or duplicate evidence.

Use a staging Firebase project, a non-production organization, a DS-K1A8503EF with the intended production firmware, and a clean supported 64-bit Windows VM/PC. Do not use real employee secrets or production biometric/customer data. Record bridge version, installer hash/signature, terminal model/serial/firmware, Windows build, Firebase project/region, organization timezone, test employee/shift, and start/end timestamps.

Before testing:

- complete the automated gate in `scripts\verify.ps1 -Full -BuildInstaller`;
- deploy staging Functions, Rules, indexes, and enable `_bridgeReplay.expiresAt` TTL;
- configure staging Firebase Authentication and active tenant membership;
- code-sign or explicitly mark the installer as a test artifact;
- ensure testers can inspect Firestore and customer-site ProgramData without sharing secrets.

## Primary scenario

Use a mapped employee assigned to a known shift. Clear only staging-derived data according to the test-data procedure; never edit raw production evidence.

1. Install HikBridge on the clean Windows machine and complete local device/cloud tests.
2. Confirm service state `running`, local pending count `0`, cloud device `online`, and bridge version.
3. Record the current Firestore raw-event count and the employee's derived day.
4. Press the mapped employee's fingerprint once for check-in.
5. Observe a local pending/uploading record before or during upload where timing permits.
6. Confirm one signed ingestion success log without secret/signature content.
7. Confirm exactly one deterministic `attendanceEvents` document in the correct organization and no event in another tenant.
8. Confirm the employee identity resolves and no new unmapped aggregate remains.
9. Confirm `attendanceDays/{employeeId}_{date}` recalculates with the source event ID and expected `missing_check_out` exception.
10. Make the checkout punch; confirm the same raw-event and derived-day checks, expected work date, hours, late/early/overtime values, and exception removal.
11. Confirm dashboard, employee detail, attendance page, reports, and CSV show the same derived values.

Pass criteria: source count rises by exactly two, each local record reaches synced, raw evidence is unchanged after recalculation, the derived result matches the configured policy, and no data crosses organizations.

## Internet failure and service restart

1. Stop outbound internet/cloud access while leaving terminal LAN access available.
2. Make a unique fingerprint punch and wait for at least one poll.
3. Confirm device polling remains successful, `pendingEvents` rises, `lastCloudError` is useful, and no credential appears in logs.
4. Restart Windows/HikBridge while internet remains unavailable.
5. Confirm checkpoint and the pending record survive; interrupted `uploading` state recovers to pending.
6. Restore internet.
7. Confirm the event uploads, becomes synced, appears once in Firestore, recalculates the correct historical day, and pending returns to zero.
8. Repeat polling of the same device time window and confirm the raw Firestore count does not change.

## Device offline and wrong password

1. Disconnect the terminal or block only its LAN port.
2. Confirm the Windows service remains running and cloud synchronization/health reporting continues.
3. Within one health interval confirm the tenant device projection reports `offline`; within five minutes a completely silent bridge must also render offline.
4. Restore the terminal and confirm automatic polling recovery, metadata, cloud `online`, and no checkpoint regression.
5. Enter an invalid device password through local setup and save.
6. Confirm clear local authentication error, no password in logs/status/browser response, and no service crash loop.
7. Restore the credential, test, save, and confirm recovery.

## Firebase unavailable or acknowledgement ambiguity

1. Point a staging build through a controlled proxy/failure endpoint or temporarily block the Functions endpoint.
2. Make punches and confirm local queue growth while device polls continue.
3. Return a connection reset/timeout after the server commit where the test harness permits it.
4. Restore normal service and confirm retries classify already-created IDs as duplicates and mark local records synced.
5. Verify every request response accounts for all submitted IDs; an incomplete/unknown/repeated-ID response must leave the batch retryable.

## Duplicate and replay checks

- Poll overlapping windows repeatedly: one local record and one cloud raw event per source event.
- Submit a signed request twice with different nonces: first accepted, second duplicate.
- Retry the identical body/nonce: idempotent replay.
- Reuse the nonce with changed bytes and a valid recomputed signature: `409 replay_conflict`.
- Submit stale timestamp, invalid signature, disabled device, cross-device event, repeated batch ID, oversized body/batch/raw event, and malformed event fields; verify the documented rejection class and no unauthorized write.

## Mapping and late evidence

1. Punch with an unmapped terminal employee number.
2. Confirm immutable raw evidence and one incremented unmapped aggregate.
3. Map it to a staging employee with a reason in the dashboard.
4. Run/wait for the mapping job and confirm historical affected dates recalculate without adding `employeeId` to the raw event.
5. Repeat the job/recalculation and confirm identical derived results.

## Overnight shift

Create an effective assignment for `22:00 -> 06:00` in the organization timezone. Punch before/after midnight and verify both source events belong to the date on which the shift started. Confirm schedule instants, worked time, missing-punch state between events, late/early/overtime policy, previous/current candidate recalculation, report grouping, and a daylight-saving transition if the product will operate in a DST timezone.

## Installer and local setup

On clean VM snapshots test fresh install, cancel before configuration, valid configuration, UAC relaunch from Start, upgrade with queued data, repair/reconfiguration, service recovery, and uninstall. Confirm setup is unreachable from a second LAN PC and rejects missing session, bad Origin/Host, and missing CSRF. Confirm stored secrets never populate browser fields. Uninstall must remove the service/application and retain ProgramData.

## Automated evidence already present

| Scenario | Automated evidence |
|---|---|
| Digest/firmware shapes/pagination | `internal/hikvision` fixtures and tests |
| deterministic ID/queue states/corruption/restart | `internal/model`, `internal/store` tests |
| slow/unavailable cloud vs polling | `internal/bridge` tests |
| signed body and event-specific acknowledgement | Go/TypeScript shared protocol vector and sync tests |
| offline signed health report | Go bridge/sync and Firestore repository tests |
| replay/deduplication/invalid payloads | Cloud ingestion unit/emulator tests |
| tenant/direct-write isolation | Firestore Rules emulator tests |
| overnight, grace, OT, missing/duplicate punches, DST | attendance engine unit tests |
| immutable repeat-safe late-event correction | attendance recalculation emulator tests |
| local setup secret/session controls | `internal/setupui` tests plus HTTP smoke test |
| reporting/device-stale behavior | dashboard unit tests |

## Evidence and exit criteria

Capture timestamps, sanitized status/log excerpts, Firestore document IDs/counts, derived calculation version/source IDs, screenshots of operational results, Windows service properties, installer logs, and tester sign-off. Never capture passwords, bridge keys, signatures, biometric templates, or unsanitized raw personal data.

Release passes only when every primary and failure scenario is green on the supported terminal firmware and clean Windows image, all automated gates pass on the release commit, open P1 items in `PRODUCTION_READINESS.md` are closed, and evidence is attached to the release record.
