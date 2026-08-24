#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif

#define MyAppName "Infact HikBridge"
#define MyAppPublisher "Infact Solutions"
#define MyAppExeName "hikbridge.exe"

[Setup]
AppId={{9F0C10F3-4EA1-4BA2-9C87-94EF3E975D24}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Hikvision attendance terminal bridge
DefaultDirName={autopf}\Infact\HikBridge
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\dist\installer
OutputBaseFilename=Infact-HikBridge-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupLogging=yes
ChangesEnvironment=no

[Files]
Source: "..\dist\hikbridge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config.example.json"; DestDir: "{app}"; DestName: "config.example.json"; Flags: ignoreversion
Source: "..\docs\INSTALLATION.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "..\docs\DEVICE_SETUP.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "..\docs\TROUBLESHOOTING.md"; DestDir: "{app}\docs"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\Infact\HikBridge"; Permissions: admins-full system-full
Name: "{commonappdata}\Infact\HikBridge\logs"; Permissions: admins-full system-full

[Icons]
Name: "{autoprograms}\{#MyAppName}\Manage HikBridge"; Filename: "{app}\{#MyAppExeName}"; Parameters: "setup --config ""{commonappdata}\Infact\HikBridge\config.json"""; WorkingDir: "{app}"
Name: "{autoprograms}\{#MyAppName}\HikBridge status"; Filename: "http://127.0.0.1:8765/status"
Name: "{autoprograms}\{#MyAppName}\Uninstall HikBridge"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\Infact\HikBridge"" /inheritance:r"; Flags: runhidden waituntilterminated
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\Infact\HikBridge"" /grant:r ""*S-1-5-18:(OI)(CI)F"" ""*S-1-5-32-544:(OI)(CI)F"""; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Parameters: "start"; StatusMsg: "Restarting the existing HikBridge service..."; Flags: runhidden waituntilterminated; Check: ExistingService
Filename: "{app}\{#MyAppExeName}"; Parameters: "setup --config ""{commonappdata}\Infact\HikBridge\config.json"""; Description: "Configure the Hikvision device and cloud registration"; Flags: postinstall nowait skipifsilent runhidden

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "RemoveHikBridgeService"

[Code]
var
  ServiceWasInstalled: Boolean;

function QueryService(var ExitCode: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query InfactHikBridge', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
end;

function ExistingService(): Boolean;
begin
  Result := ServiceWasInstalled;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  QueryCode: Integer;
  StopCode: Integer;
begin
  Result := '';
  ServiceWasInstalled := QueryService(QueryCode) and (QueryCode = 0);
  if ServiceWasInstalled and FileExists(ExpandConstant('{app}\{#MyAppExeName}')) then
  begin
    if not Exec(ExpandConstant('{app}\{#MyAppExeName}'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, StopCode) or (StopCode <> 0) then
      Result := 'The existing Infact HikBridge service could not be stopped. Close service management tools and retry.';
  end;
end;
