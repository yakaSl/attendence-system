# Installing Infact HikBridge on Windows

## Requirements

- Windows 10 version 1809 or later, or Windows Server 2019 or later (64-bit)
- A local Windows administrator account
- Network access from the PC to the Hikvision attendance terminal
- Outbound HTTPS access to the Infact cloud ingestion endpoint
- A one-time installation code and bridge credential created in the Infact dashboard

The customer PC does not need Go, Git, Node.js, or an editor.

## Interactive installation

1. Copy `Infact-HikBridge-Setup-<version>.exe` to the target PC and verify its source/signature according to your release process.
2. Run the installer as an administrator and keep the default install location unless local policy requires another location.
3. Leave **Configure the Hikvision device and cloud registration** selected on the final page.
4. In the local management window opened on `127.0.0.1`, enter the terminal network details and select **Test device**.
5. Enter the one-time installation code, bridge credential, and cloud ingestion endpoint. Select **Test cloud**.
6. Select **Save & start service**. The service panel should report **Running** and show its Windows process ID.
7. Open `http://127.0.0.1:8765/status` on the same PC and confirm device connectivity and queue counts.

The configuration, queue, checkpoint, and logs are stored under:

```text
C:\ProgramData\Infact\HikBridge
```

That directory is restricted to Local System and local Administrators. The executable is installed under:

```text
C:\Program Files\Infact\HikBridge
```

## Reconfiguration and upgrades

Use **Start > Infact HikBridge > Manage HikBridge**. Windows requests administrator approval. The management GUI shows live service status and provides **Install service**, **Start**, **Stop**, **Restart**, and **Uninstall service** actions. Service removal retains configuration, logs, and queued event evidence. Stored device and cloud secrets are not returned to the browser; leave a secret field blank to keep it. Saving restarts the service when required.

An upgrade stops the existing service, replaces application files, and starts it again. Existing configuration and queued event evidence remain in ProgramData.

## Silent installation

```powershell
Infact-HikBridge-Setup-0.1.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Silent installation intentionally does not invent or package customer credentials. After installation, an administrator must run:

```powershell
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' setup
```

## Uninstall

Use Windows **Installed apps** or the Start menu uninstall shortcut. Uninstall removes the Windows service and installed application files. It deliberately retains configuration, logs, checkpoints, and event evidence in ProgramData. Remove retained data only after the customer confirms retention/export requirements.

## Building the installer

Maintainers need Go and Inno Setup 6:

```powershell
.\installer\build-installer.ps1 -Version 0.1.0
```

The version is embedded into `hikbridge.exe` and the installer metadata. The output is created in `dist\installer`. Never add a customer password or bridge credential to the installer sources.
