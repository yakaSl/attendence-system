# Windows Service Operations

## Identity and lifecycle

The service name is `InfactHikBridge` and display name is **Infact Hikvision Bridge**. It runs as Local System, starts automatically, accepts stop/shutdown, and is configured to restart after 5 seconds, 15 seconds, and 1 minute for crash and non-crash failures. A wrong terminal password does not terminate the process; polling continues with bounded retries.

The installed binary receives:

```text
hikbridge.exe run --config C:\ProgramData\Infact\HikBridge\config.json
```

Service Control Manager transitions are acknowledged promptly. The bridge cancels polling/cloud/maintenance loops, shuts down the local HTTP server, and waits for workers before exiting.

## Administration

Run from an elevated PowerShell session:

```powershell
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' status
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' start
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' stop
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' restart
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' version
```

Use the Start menu **Manage HikBridge** shortcut for normal administration. It requests UAC and opens a one-time loopback management session. The GUI reports live service state and PID, provides install/start/stop/restart/uninstall controls, writes configuration atomically, and restarts the service after configuration changes.

## Files and permissions

```text
C:\Program Files\Infact\HikBridge\hikbridge.exe
C:\ProgramData\Infact\HikBridge\config.json
C:\ProgramData\Infact\HikBridge\checkpoint.txt
C:\ProgramData\Infact\HikBridge\events\pending\
C:\ProgramData\Infact\HikBridge\events\synced\
C:\ProgramData\Infact\HikBridge\events\failed\
C:\ProgramData\Infact\HikBridge\logs\hikbridge.log
```

ProgramData inheritance is removed and full control is granted only to Local System and local Administrators by SID. Do not broaden these ACLs: `config.json` contains the terminal password and per-device bridge key.

Pending and failed evidence has no automatic deletion. Synced records are redundant after a cloud acknowledgement and are pruned after `syncedRetentionDays` (90 by default). JSON logs rotate at `logMaxMegabytes` and retain `logBackups` files.

## Local endpoints

`/health` and `/status` listen on `127.0.0.1:8765` by default. Status includes connectivity, last poll/sync/error timestamps, queue-state counts, totals, metadata, version, and uptime. It does not include configuration or credentials.

The management application listens on `127.0.0.1:8766` only while open. It requires a one-time launch token, HttpOnly same-site session cookie, exact Origin/Host, CSRF token, and restrictive browser security policy. Stored secrets are represented only by presence flags. Service mutations are serialized and require the elevated local session; uninstalling the service retains ProgramData.

## Upgrade and uninstall

The Inno installer detects and stops an existing service before replacing the executable, retains ProgramData, and restarts an existing installation. Fresh installs launch setup; the service is created only after valid configuration is saved.

Uninstall invokes service removal before deleting application files and deliberately retains ProgramData. Treat any later manual removal of that directory as an evidence-retention decision, not routine cleanup.

## Support checks

1. Run `status` and open the loopback status JSON.
2. Check Windows Services for name, Local System identity, automatic startup, and recovery actions.
3. Run `test-device` and `test-cloud` using the installed config.
4. Review the latest structured log without copying credentials/configuration.
5. Confirm disk space and pending/failed counts before restart or upgrade.
