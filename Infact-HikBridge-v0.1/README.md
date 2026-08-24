# Infact HikBridge Attendance Cloud

Infact HikBridge connects a Hikvision fingerprint attendance terminal on a customer LAN to a multi-tenant Firebase attendance application. The Windows bridge polls ISAPI, saves every event locally before advancing its checkpoint, uploads signed batches when the internet is available, and reports device health. Cloud Functions authenticate and deduplicate evidence, resolve employees, calculate attendance, and expose tenant-scoped operational data to the Next.js dashboard.

The bridge transports evidence; it does not calculate shifts, lateness, leave, or overtime. Raw cloud events remain immutable so historical attendance can be recalculated after delayed punches, mappings, corrections, or policy changes.

## Architecture

```text
Hikvision DS-K1A8503EF
  -> HTTP Digest / ISAPI on the local LAN
  -> HikBridge Windows Service
       durable checkpoint + pending/uploading/synced/failed records
  -> HTTPS + per-device HMAC v1
  -> Firebase Function + Secret Manager + replay protection
  -> immutable Firestore attendanceEvents
  -> identity mapping + attendance-v1 recalculation
  -> derived attendanceDays
  -> authenticated Next.js HR operations dashboard
```

See [Architecture](docs/ARCHITECTURE.md), [Hikvision integration](docs/HIKVISION_INTEGRATION.md), [Firebase architecture](docs/FIREBASE_ARCHITECTURE.md), and [Security model](docs/SECURITY_MODEL.md).

## Repository layout

```text
cmd/hikbridge/       Go CLI and Windows Service entry point
internal/            device, queue, sync, setup, logging, and service packages
cloud/               Firebase Functions, Rules, indexes, and emulator tests
web/                 Next.js attendance operations dashboard
installer/           Inno Setup definition and build script
scripts/             build, install, uninstall, and verification automation
docs/                architecture, deployment, operations, QA, and user guides
```

## Development setup

Requirements are Go 1.23+, Node.js 20, npm, and Java 21 for Firebase Emulator Suite. Inno Setup 6 is required only to compile the Windows installer.

```powershell
cd cloud
npm install
cd ..\web
npm install
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

Run the complete emulator gate with the Java 21 installation directory when it is not already first on `Path`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 `
  -Full `
  -JavaHome 'C:\Program Files\Eclipse Adoptium\jdk-21'
```

The verification script targets only `cmd/` and `internal/` Go packages so nested Node dependency trees are never mistaken for project Go packages.

## Build commands

Build the versioned Windows bridge:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1 -Version 0.1.0
```

Build the customer installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\build-installer.ps1 -Version 0.1.0
```

Output is written to `dist/`, including `dist\installer\Infact-HikBridge-Setup-0.1.0.exe`. Release artifacts must be code-signed outside this repository before distribution.

## Windows installation

Customers need only the signed installer; Go, Git, Node.js, and an editor are not required. The installer copies the executable, creates and secures ProgramData, and launches the local management GUI. The administrator can configure and test the terminal, then install, start, stop, restart, or uninstall the automatic Windows service from the same protected screen. **Save & start service** applies configuration and brings the bridge online in one action.

Setup and diagnostics bind only to the local PC:

```text
http://127.0.0.1:8766  setup (only while setup is open)
http://127.0.0.1:8765  health and status
```

Configuration, queue evidence, checkpoint, and logs live in `C:\ProgramData\Infact\HikBridge`, restricted to Local System and Administrators. Uninstall retains that data by default. Follow [Installation](docs/INSTALLATION.md) and [Windows Service](docs/WINDOWS_SERVICE.md).

## Hikvision setup and diagnostics

```powershell
.\hikbridge.exe setup --config .\config.json --no-service
.\hikbridge.exe test-device --config .\config.json
.\hikbridge.exe test-users --config .\config.json
.\hikbridge.exe test-events --config .\config.json --minutes 10
.\hikbridge.exe run --config .\config.json
```

Use `--raw` on `test-events` only during controlled support work because device payloads can contain employee identifiers. See [Device setup](docs/DEVICE_SETUP.md).

## Firebase setup

1. Create a staging Firebase/Google Cloud project and enable Firestore, Firebase Authentication, Cloud Functions, Secret Manager, and Cloud Scheduler.
2. Review `cloud/firebase.json`, deploy `cloud/firestore.rules` and `cloud/firestore.indexes.json`, and enable TTL on `_bridgeReplay.expiresAt`.
3. Grant the Functions runtime only the Secret Manager and Firebase permissions required by the documented workflows.
4. Deploy Functions from `cloud/`; the bridge ingestion function is `hikbridgeV1Events` in `asia-south1`.
5. Configure Firebase web values in `web/.env.local` from `web/.env.example`; never put a service-account key in the dashboard.
6. Deploy Firestore Rules and the production dashboard with `NEXT_PUBLIC_DEMO_MODE=false`. A signed-in user without a default organization is sent through the required organization setup wizard.
7. Provision a device from `/devices` and capture the bridge credential shown once.

The wizard creates the organization, owner membership, primary branch, default shift, user profile link, and creation audit in one Firestore transaction. Bootstrap-only Rules require the complete validated document set, an unused organization identifier, and a user without an existing default organization. This path works on Firebase's Spark plan; the equivalent `bootstrapOrganization` callable is retained for a future Blaze deployment.

For recovery or controlled administration only, the fail-closed CLI bootstrap remains available:

```powershell
npm run bootstrap:owner -- --project <project-id> --uid <firebase-auth-uid> --organization <organization-id> --name "Organization Name" --timezone Asia/Colombo --branch colombo --branch-name "Colombo HQ"
```

The recovery command uses the project-owner Firebase CLI identity and refuses to overwrite existing or partial ownership data. It is not part of the normal first-login flow.

Deployment is intentionally not performed by repository tests. Complete the staging and IAM checks in [Production readiness](docs/PRODUCTION_READINESS.md).

## Testing

The standard gate covers Go format/tests/vet, Cloud lint/types/unit tests/build, dashboard lint/types/tests/build, and optionally Firestore Rules/repository emulator tests and installer compilation.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -Full -BuildInstaller -Version 0.1.0
```

Automated coverage includes Digest authentication, Hikvision fixture pagination, malformed-response preservation, queue crash recovery, cloud failure/recovery, HMAC contract vectors shared with TypeScript, duplicate/replay handling, status heartbeat, Firestore tenant Rules, immutable recalculation, overnight shifts, corrections, reports, and setup-session security. Physical terminal and clean Windows VM cases remain manual release gates in [End-to-end test plan](docs/END_TO_END_TEST_PLAN.md).

## Operations and security

- No Firebase Admin credential is installed at a customer site.
- Production cloud URLs require HTTPS; development HTTP is accepted only on loopback with an explicit flag.
- Stored Hikvision and bridge secrets are never returned by local setup and are protected by ProgramData ACLs.
- Pending/failed event evidence is retained. Cloud-acknowledged local records expire after the configured retention period (90 days by default).
- The bridge sends signed health reports every 60 seconds; the dashboard treats five minutes without a report as offline.
- Logs rotate and never intentionally include passwords, bridge keys, HMAC signatures, or full configuration.

For operational failures use [Troubleshooting](docs/TROUBLESHOOTING.md). The current release verdict and remaining gates are in [Production readiness](docs/PRODUCTION_READINESS.md).
