# Realtime Command Delivery

## Goal

HikBridge keeps attendance retrieval and upload reliable while eliminating idle command polling. Firestore remains the durable command queue. Firebase Realtime Database carries only a small, overwrite-only wake signal; it is never the command system of record.

```text
HR action
  -> callable creates durable Firestore command
  -> callable overwrites one device-scoped RTDB signal
  -> bridge's persistent Firebase stream wakes
  -> signed hikbridgeV1Events exchange leases the command
  -> local Hikvision operation
  -> durable local result + immediate signed acknowledgement
```

The Go Firebase Admin SDK has no realtime-listener API, so the bridge uses Firebase's REST streaming protocol (`text/event-stream`). This provides the cost and latency properties needed here without an always-running Cloud Run WebSocket service. The signal is a hint only: reconnect reconciliation and bounded fallback polling recover every durable Firestore command if a signal is missed.

## Expected request reduction

With a five-second legacy command interval, an idle bridge could make 17,280 command exchanges per day. While its realtime stream is healthy, the new bridge makes no idle command exchange calls. It exchanges only at startup/reconnect and when actual commands or acknowledgements exist.

Realtime mode also floors the low-priority Firestore status heartbeat at four minutes: at most 360 scheduled status calls per day instead of 1,440 at the previous one-minute default. Attendance batches are not delayed by that heartbeat. New locally durable events wake the upload loop immediately, and empty event batches never call the cloud.

The Employees page no longer reloads employee, attendance, branch, department, device, and enrollment collections every three seconds during capture. It listens to the exact `deviceEnrollments/{id}` document for the active enrollment and performs one full refresh only on terminal success or failure.

These numbers are workload estimates, not a guarantee that a project remains inside a Firebase no-cost plan. Track Realtime Database simultaneous connections/bandwidth plus Functions and Firestore usage in the staging and production projects.

## Enrollment latency and evidence protection

- The callable writes the command and wake signal in the same user request; there is no extra Firestore-trigger cold start.
- A failed signal is retried three times. The Firestore command remains durable and disconnected fallback polling expands from seconds to a maximum of five minutes.
- The bridge performs an attendance poll immediately before fingerprint capture and another immediately afterward. A punch made during the terminal's exclusive capture window remains on the terminal and is collected after capture.
- A successful terminal-user upsert is cached locally. A following fingerprint command with the same employee number and name skips the duplicate terminal lookup/upsert. If fingerprint assignment proves that the user was manually removed, HikBridge recreates the user and retries the assignment with the already captured in-memory template.
- Biometric template data remains in bridge memory and local terminal requests only. It is not written to RTDB, Firestore, logs, or the local provisioning cache.

## Firebase setup

1. Create the project's default Realtime Database in `asia-southeast1` before deployment. Firebase fixes this location when the database is created.
2. Set these Functions environment values:

   ```text
   BRIDGE_REALTIME_DATABASE_URL=https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app
   BRIDGE_FIREBASE_WEB_API_KEY=<Firebase web API key>
   ```

3. Deploy `database.rules.json` and the Functions that create sessions and employee commands.
4. Set `cloud.realtimeEnabled` to `true` and `cloud.realtimeSessionUrl` to the deployed `hikbridgeV1Session` HTTPS URL in each bridge configuration. The local setup UI exposes both fields under Advanced cloud options.
5. Restart the bridge and verify `/status` reports `realtimeConnected: true` and a recent `lastRealtimeConnect`.

The Firebase web API key identifies the Firebase project and is not the bridge credential. The session Function still requires the normal per-device HMAC signature before issuing a short-lived, device-scoped Firebase custom token.

## Failure behavior

- RTDB unavailable: attendance upload continues; command delivery uses bounded fallback polling.
- Functions/Firestore unavailable: command signals may arrive, but the durable command is leased only after the signed endpoint recovers.
- Bridge restart: the bridge reconciles commands immediately after startup and reconnects the stream.
- Token expiry/revocation: Firebase Auth refresh is attempted without calling the session Function; a rejected refresh creates a new signed session.
- Duplicate/old signal: it can cause a harmless reconciliation call but cannot duplicate a command because command leases and durable local results remain authoritative.

Physical-terminal latency and attendance-during-capture behavior remain release gates and must be measured with the target Hikvision model and firmware.
