param(
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')]
    [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$isccCandidates = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source,
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $iscc) {
    throw 'Inno Setup 6 was not found. Install it, then rerun this script.'
}

& (Join-Path $repositoryRoot 'scripts\build.ps1') -Version $Version
if ($LASTEXITCODE -ne 0) { throw 'HikBridge executable build failed.' }

$scriptPath = Join-Path $PSScriptRoot 'Infact-HikBridge.iss'
& $iscc "/DMyAppVersion=$Version" $scriptPath
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }

$installerPath = Join-Path $repositoryRoot "dist\installer\Infact-HikBridge-Setup-$Version.exe"
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer output was not created: $installerPath"
}
Write-Host "Built installer: $installerPath"
