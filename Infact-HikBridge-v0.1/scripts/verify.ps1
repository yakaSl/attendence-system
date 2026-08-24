param(
    [switch]$Full,
    [switch]$BuildInstaller,
    [string]$JavaHome = '',
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$')]
    [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repositoryRoot
$env:GOCACHE = Join-Path $workspaceRoot '.cache\go-build'
$env:XDG_CONFIG_HOME = Join-Path $workspaceRoot '.cache\config'

function Invoke-Checked {
    param([scriptblock]$Command, [string]$Description)
    Write-Host "`n== $Description =="
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

Push-Location $repositoryRoot
try {
    $goFiles = & rg --files cmd internal -g '*.go'
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate Go files.' }
    $unformatted = & gofmt -l $goFiles
    if ($LASTEXITCODE -ne 0) { throw 'gofmt check failed.' }
    if ($unformatted) { throw "Go files require formatting:`n$($unformatted -join "`n")" }
    Invoke-Checked { go test .\cmd\... .\internal\... } 'Go tests'
    Invoke-Checked { go vet .\cmd\... .\internal\... } 'Go vet'

    if (Get-Command gcc -ErrorAction SilentlyContinue) {
        Invoke-Checked { go test -race .\internal\... } 'Go race detector'
    }
    else {
        Write-Warning 'Go race detector skipped because a C compiler is not installed.'
    }

    Push-Location (Join-Path $repositoryRoot 'cloud')
    try {
        Invoke-Checked { npm run lint } 'Cloud lint'
        Invoke-Checked { npm run typecheck } 'Cloud typecheck'
        Invoke-Checked { npm test } 'Cloud unit tests'
        Invoke-Checked { npm run build } 'Cloud build'
        if ($Full) {
            if ($JavaHome) {
                if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
                    throw "Java executable not found under $JavaHome"
                }
                $env:JAVA_HOME = $JavaHome
                $env:Path = (Join-Path $JavaHome 'bin') + ';' + $env:Path
            }
            $javaVersion = (& java --version | Select-Object -First 1) -join ''
            if ($LASTEXITCODE -ne 0) { throw 'Could not determine the Java version.' }
            if ($javaVersion -notmatch '(?:version "|openjdk |java )(\d+)' -or [int]$Matches[1] -lt 21) {
                throw "Full verification requires Java 21 or later; found: $javaVersion"
            }
            Invoke-Checked { npm run test:rules } 'Firestore rules and repository emulator tests'
        }
    }
    finally { Pop-Location }

    Push-Location (Join-Path $repositoryRoot 'web')
    try {
        Invoke-Checked { npm run lint } 'Dashboard lint'
        Invoke-Checked { npm run typecheck } 'Dashboard typecheck'
        Invoke-Checked { npm test } 'Dashboard tests'
        Invoke-Checked { npm run build } 'Dashboard production build'
    }
    finally { Pop-Location }

    if ($BuildInstaller) {
        Invoke-Checked {
            powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\build-installer.ps1 -Version $Version
        } 'Windows installer build'
    }
}
finally {
    Pop-Location
}

Write-Host "`nInfact HikBridge verification completed successfully."
