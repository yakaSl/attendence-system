#Requires -RunAsAdministrator

param(
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$installDirectory = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'Infact\HikBridge'))
$dataDirectory = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Infact\HikBridge'))
$installedExecutable = Join-Path $installDirectory 'hikbridge.exe'

$service = Get-Service -Name 'InfactHikBridge' -ErrorAction SilentlyContinue
if ($null -ne $service) {
    if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
        throw "The service exists but its management executable is missing: $installedExecutable"
    }
    & $installedExecutable uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Windows Service removal failed.' }
}

$expectedInstallDirectory = [IO.Path]::GetFullPath("$($env:ProgramFiles)\Infact\HikBridge")
if ($installDirectory -ne $expectedInstallDirectory) {
    throw "Refusing to remove unexpected install directory: $installDirectory"
}
if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

if ($RemoveData) {
    $expectedDataDirectory = [IO.Path]::GetFullPath("$($env:ProgramData)\Infact\HikBridge")
    if ($dataDirectory -ne $expectedDataDirectory) {
        throw "Refusing to remove unexpected data directory: $dataDirectory"
    }
    if (Test-Path -LiteralPath $dataDirectory) {
        Remove-Item -LiteralPath $dataDirectory -Recurse -Force
    }
    Write-Host 'Infact HikBridge and its local event archive were removed.'
}
else {
    Write-Host "Infact HikBridge was removed. Local configuration and event evidence were retained at $dataDirectory"
}
