param(
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')]
    [string]$Version = '0.1.0',
    [string]$UpdateManifestURL = '',
    [string]$CloudIngestURL = 'https://asia-south1-infact-attendance-128ee.cloudfunctions.net/hikbridgeV1Events',
    [string]$RealtimeSessionURL = 'https://asia-south1-infact-attendance-128ee.cloudfunctions.net/hikbridgeV1Session',
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $repositoryRoot $OutputDirectory
$binaryPath = Join-Path $outputPath 'hikbridge.exe'

$strictVersion = [regex]::Match($Version, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
if (-not $strictVersion.Success) {
    throw 'Version must be a valid semantic version such as 1.2.3 or 1.2.3-rc.1.'
}
if ($strictVersion.Groups[4].Success) {
    foreach ($identifier in $strictVersion.Groups[4].Value.Split('.')) {
        if ($identifier -match '^0[0-9]+$') {
            throw 'Numeric prerelease version identifiers must not contain leading zeroes.'
        }
    }
}

if ($UpdateManifestURL) {
    $parsedUpdateManifestURL = $null
    if (-not [Uri]::TryCreate($UpdateManifestURL, [UriKind]::Absolute, [ref]$parsedUpdateManifestURL) -or
        $parsedUpdateManifestURL.Scheme -ne 'https' -or $parsedUpdateManifestURL.UserInfo) {
        throw 'UpdateManifestURL must be an absolute HTTPS URL without user information.'
    }
}

foreach ($cloudEndpoint in @($CloudIngestURL, $RealtimeSessionURL)) {
    $parsedCloudEndpoint = $null
    if (-not [Uri]::TryCreate($cloudEndpoint, [UriKind]::Absolute, [ref]$parsedCloudEndpoint) -or
        $parsedCloudEndpoint.Scheme -ne 'https' -or $parsedCloudEndpoint.UserInfo) {
        throw 'Cloud endpoints must be absolute HTTPS URLs without user information.'
    }
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
Push-Location $repositoryRoot
try {
    # Keep Go package discovery out of nested Node.js dependency trees.
    go test ./cmd/... ./internal/...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed.' }

    go vet ./cmd/... ./internal/...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed.' }

    $linkerFlags = "-s -w -X main.version=$Version"
    if ($UpdateManifestURL) { $linkerFlags += " -X main.updateManifestURL=$UpdateManifestURL" }
    $linkerFlags += " -X main.cloudIngestURL=$CloudIngestURL -X main.cloudRealtimeSessionURL=$RealtimeSessionURL"
    go build -trimpath -ldflags $linkerFlags -o $binaryPath .\cmd\hikbridge
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed.' }
}
finally {
    Pop-Location
}

Write-Host "Built Infact HikBridge $Version"
if ($UpdateManifestURL) { Write-Host "Update manifest: $UpdateManifestURL" }
else { Write-Warning 'This development build has no update manifest URL and will not display online update notices.' }
Write-Host "Cloud ingestion: $CloudIngestURL"
Write-Host "Realtime session: $RealtimeSessionURL"
Write-Host $binaryPath
