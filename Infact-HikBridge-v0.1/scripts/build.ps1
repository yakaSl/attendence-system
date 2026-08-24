param(
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')]
    [string]$Version = '0.1.0',
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $repositoryRoot $OutputDirectory
$binaryPath = Join-Path $outputPath 'hikbridge.exe'

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
Push-Location $repositoryRoot
try {
    # Keep Go package discovery out of nested Node.js dependency trees.
    go test ./cmd/... ./internal/...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed.' }

    go vet ./cmd/... ./internal/...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed.' }

    go build -trimpath -ldflags "-s -w -X main.version=$Version" -o $binaryPath .\cmd\hikbridge
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed.' }
}
finally {
    Pop-Location
}

Write-Host "Built Infact HikBridge $Version"
Write-Host $binaryPath
