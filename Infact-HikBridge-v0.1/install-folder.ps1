# Run in an elevated PowerShell window.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'Infact\HikBridge'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Restrict the folder because config.json contains the Hikvision device credential in MVP v0.1.
icacls $dir /inheritance:r | Out-Null
icacls $dir /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

Write-Host "Created and secured $dir"
Write-Host "Copy config.example.json to $dir\config.json and edit it."
Write-Host "Then run: .\hikbridge.exe test-device"
Write-Host "If successful: .\hikbridge.exe install"
Write-Host "Start with: Start-Service InfactHikBridge"
