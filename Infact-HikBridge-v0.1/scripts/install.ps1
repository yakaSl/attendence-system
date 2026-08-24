#Requires -RunAsAdministrator

param(
    [string]$SourceExecutable = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\hikbridge.exe'),
    [string]$ConfigTemplate = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.example.json')
)

$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $env:ProgramFiles 'Infact\HikBridge'
$dataDirectory = Join-Path $env:ProgramData 'Infact\HikBridge'
$installedExecutable = Join-Path $installDirectory 'hikbridge.exe'
$configPath = Join-Path $dataDirectory 'config.json'

if (-not (Test-Path -LiteralPath $SourceExecutable -PathType Leaf)) {
    throw "HikBridge executable not found: $SourceExecutable. Run scripts\build.ps1 first."
}
if (-not (Test-Path -LiteralPath $ConfigTemplate -PathType Leaf)) {
    throw "Configuration template not found: $ConfigTemplate"
}

$existingService = Get-Service -Name 'InfactHikBridge' -ErrorAction SilentlyContinue
if ($null -ne $existingService -and $existingService.Status -ne 'Stopped') {
    if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) {
        & $installedExecutable stop
        if ($LASTEXITCODE -ne 0) { throw 'The existing HikBridge service could not be stopped.' }
    }
    else {
        Stop-Service -Name 'InfactHikBridge' -ErrorAction Stop
    }
}

New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDirectory 'logs') | Out-Null
Copy-Item -LiteralPath $SourceExecutable -Destination $installedExecutable -Force

if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath $ConfigTemplate -Destination $configPath
    Write-Warning "Created $configPath. Replace placeholder device credentials before installing the service."
    Write-Host "Run: `"$installedExecutable`" test-device --config `"$configPath`""
    exit 2
}

icacls $dataDirectory /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable inherited permissions on the data directory.' }
icacls $dataDirectory /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict the data directory permissions.' }

& $installedExecutable test-device --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Device connectivity test failed. The service was not installed or started.' }

if ($null -eq $existingService) {
    & $installedExecutable install --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Windows Service installation failed.' }
}

& $installedExecutable start
if ($LASTEXITCODE -ne 0) { throw 'Windows Service start failed.' }

Write-Host 'Infact HikBridge installed and running.'
Write-Host "Configuration: $configPath"
Write-Host "Logs: $(Join-Path $dataDirectory 'logs')"
