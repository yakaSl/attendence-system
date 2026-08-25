# Cloud Fingerprint Enrollment

## What this workflow does

An organization owner or HR administrator creates the employee in the cloud and starts enrollment from the Employees page. The authenticated bridge receives a short-lived command, creates or updates the matching terminal user, asks the local Hikvision scanner to capture the selected finger, and assigns the captured template back to that terminal.

The biometric template never enters Firestore or the dashboard. The cloud retains only enrollment state, finger slot, terminal-reported quality, timestamps, and a bounded error message.

## One-time deployment

Deploy the updated ingestion endpoint, employee callables, and Firestore Rules from the Firebase project directory:

```powershell
cd C:\dev\attendence-system\Infact-HikBridge-v0.1\cloud
npm install
npm run build
npx firebase-tools deploy --only "functions:hikbridgeV1Events,functions:createEmployee,functions:requestFingerprintEnrollment,firestore:rules"
```

Build and deploy the updated dashboard using the same Firebase project and `NEXT_PUBLIC_DEMO_MODE=false`:

```powershell
cd ..\web
npm install
npm run build
```

The installed Windows service must use a bridge executable built from this version. For a development test, stop the installed service first so only one process owns the local data directory, then run:

```powershell
cd C:\dev\attendence-system\Infact-HikBridge-v0.1
go run .\cmd\hikbridge run --config .\local\config.json
```

For a customer installation, build and install the versioned installer instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\build-installer.ps1 -Version 0.1.0
```

## Preconditions

- The terminal is provisioned from the cloud Devices page and assigned to the correct branch.
- HikBridge uses the provisioned `deviceId`, ingestion URL, and bridge key and reports `deviceConnected: true` at `http://127.0.0.1:8765/status`.
- The terminal reports support for `UserInfo`, `CaptureFingerPrint`, and `FingerPrintCfg` setup.
- The employee is physically beside the selected terminal. Enrollment expires after five minutes.
- Only one bridge process runs for a device and only one fingerprint enrollment is active on a terminal.

## Enroll an employee

1. Sign in as an organization owner or HR administrator.
2. Open **Employees** and select **Add employee**.
3. Enter an employee code of 1–32 letters, digits, dots, underscores, or hyphens. This exact code becomes Hikvision `employeeNo`.
4. Select the employee's branch and, optionally, a terminal in that same branch. Select **Create employee**.
5. In the employee table, select the fingerprint state for that employee.
6. Select the same-branch terminal and finger slot 1–10, then select **Start enrollment**.
7. Immediately place the employee's finger on the terminal scanner and hold it until the terminal completes capture.
8. Watch the state change from **Enrollment queued** to **Touch scanner**, then **Enrolled**. The page refreshes active enrollment state every three seconds.

The bridge always upserts the terminal user before capture, so enrollment also works for an employee initially created as cloud-only.

## State meanings

| State | Meaning |
| --- | --- |
| Syncing user | A create/update-user command is waiting for the bridge. |
| Ready to enroll | The terminal user was synchronized successfully. |
| Enrollment queued | The cloud accepted a five-minute enrollment command. |
| Touch scanner | The bridge leased the command and is working with the terminal. |
| Enrolled | The terminal accepted the fingerprint; quality is stored as metadata. |
| Enrollment failed | The command expired, capture failed, or the reader rejected setup. The error is available as the fingerprint control tooltip. |

Realtime-enabled bridges receive the wake immediately instead of waiting for a periodic command poll. During an active enrollment, the browser listens only to that enrollment document instead of reloading the Employees page every three seconds. HikBridge also avoids repeating a terminal user upsert that it has already confirmed for the same employee number and name; a stale cache is repaired automatically if fingerprint assignment reports that the terminal user is missing.

To protect important attendance transfer, the bridge performs a device event poll immediately before entering the exclusive fingerprint-capture operation and again immediately afterward. Events created during capture remain buffered by the terminal and are uploaded as soon as the post-capture poll makes them durable locally.

## Diagnostics

Check bridge command activity without exposing biometric content:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/status |
  Select-Object deviceConnected,realtimeConnected,lastRealtimeConnect,lastRealtimeError,lastCommandPoll,lastCommandError,activeCommandId,activeCommandType,pendingCommandResults,commandsReceived,commandsSucceeded,commandsFailed
```

If the cloud page remains at **Enrollment queued**, confirm the updated bridge is running and can reach the cloud. If it reaches **Enrollment failed**, inspect `lastCommandError` and the local bridge log. Common causes are no finger presented before timeout, low capture quality, a full/offline fingerprint reader, invalid terminal credentials, or a terminal assigned to a different branch.

Never paste fingerprint response bodies or `fingerData` into tickets, logs, chat, or test fixtures.
