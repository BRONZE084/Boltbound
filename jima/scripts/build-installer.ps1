[CmdletBinding()]
param([switch]$KeepWorkDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd("\")
$installerDirectory = Join-Path $repoRoot "installer"
$launcherSource = Join-Path $installerDirectory "Launcher.cs"
$installScript = Join-Path $installerDirectory "install.ps1"
$uninstallScript = Join-Path $installerDirectory "uninstall.ps1"
$workRoot = Join-Path $repoRoot ".installer-build"
$payloadRoot = Join-Path $workRoot "payload"
$payloadZip = Join-Path $workRoot "payload.zip"
$iexpressSource = Join-Path $workRoot "iexpress"
$releaseDirectory = Join-Path $repoRoot "release"
$setupPath = Join-Path $releaseDirectory "ZaoluRace-Setup.exe"
$candidateSetupPath = Join-Path $workRoot "ZaoluRace-Setup.exe"
$publishCandidate = Join-Path $releaseDirectory "ZaoluRace-Setup.exe.new"
$previousSetupPath = Join-Path $releaseDirectory "ZaoluRace-Setup.exe.previous"
$cloudflaredSource = Join-Path $repoRoot ".runtime\cloudflared-windows-amd64.exe"
$cloudflaredSha256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5"
$buildSucceeded = $false

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside the repository: $fullPath"
    }
    return $fullPath
}

function Reset-BuildDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $safePath = Assert-ChildPath -Path $Path -Root $repoRoot
    if (Test-Path -LiteralPath $safePath) {
        Remove-Item -LiteralPath $safePath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $safePath -Force | Out-Null
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Find-CSharpCompiler {
    foreach ($candidate in @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "The built-in .NET Framework C# compiler was not found."
}

try {
    foreach ($requiredFile in @($launcherSource, $installScript, $uninstallScript, (Join-Path $repoRoot "package.json"), (Join-Path $repoRoot "package-lock.json"))) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Required build input is missing: $requiredFile"
        }
    }
    if (-not (Test-Path -LiteralPath $cloudflaredSource -PathType Leaf)) {
        throw "Verified cloudflared runtime is missing: $cloudflaredSource"
    }
    $actualCloudflaredHash = (Get-FileHash -LiteralPath $cloudflaredSource -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualCloudflaredHash -cne $cloudflaredSha256) {
        throw "cloudflared SHA-256 mismatch. Expected $cloudflaredSha256, got $actualCloudflaredHash."
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction Stop }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction Stop }

    Push-Location $repoRoot
    try {
        Invoke-Checked -FilePath $npmCommand.Source -Arguments @("run", "build:all") -Description "Synchronized desktop and WeChat build"
    }
    finally { Pop-Location }

    Reset-BuildDirectory -Path $workRoot
    New-Item -ItemType Directory -Path $payloadRoot, (Join-Path $payloadRoot "runtime"), (Join-Path $payloadRoot "app"), $iexpressSource -Force | Out-Null

    $appStage = Join-Path $payloadRoot "app"
    Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $appStage -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "package-lock.json") -Destination $appStage -Force
    foreach ($directoryName in @("server", "shared", "dist")) {
        $sourceDirectory = Join-Path $repoRoot $directoryName
        if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
            throw "Required application directory is missing: $sourceDirectory"
        }
        Copy-Item -LiteralPath $sourceDirectory -Destination $appStage -Recurse -Force
    }

    Push-Location $appStage
    try {
        Invoke-Checked -FilePath $npmCommand.Source -Arguments @("ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund") -Description "Production dependency install"
        Invoke-Checked -FilePath $npmCommand.Source -Arguments @("ls", "--omit=dev", "--depth=0") -Description "Production dependency verification"
    }
    finally { Pop-Location }
    foreach ($devOnlyPackage in @("vite", "phaser", "concurrently", "socket.io-client")) {
        if (Test-Path -LiteralPath (Join-Path $appStage "node_modules\$devOnlyPackage")) {
            throw "Development dependency was unexpectedly staged: $devOnlyPackage"
        }
    }

    $runtimeDirectory = Join-Path $payloadRoot "runtime"
    Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimeDirectory "node.exe") -Force
    Copy-Item -LiteralPath $cloudflaredSource -Destination (Join-Path $runtimeDirectory "cloudflared.exe") -Force
    $stagedCloudflaredHash = (Get-FileHash -LiteralPath (Join-Path $runtimeDirectory "cloudflared.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedCloudflaredHash -cne $cloudflaredSha256) {
        throw "The staged cloudflared runtime failed verification."
    }
    Copy-Item -LiteralPath $uninstallScript -Destination (Join-Path $payloadRoot "uninstall.ps1") -Force

    $csc = Find-CSharpCompiler
    $launcherOutput = Join-Path $payloadRoot "Launcher.exe"
    $compilerArguments = @(
        "/nologo", "/warn:4", "/target:winexe", "/optimize+", "/platform:anycpu",
        "/codepage:65001",
        "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        "/out:$launcherOutput", $launcherSource
    )
    Invoke-Checked -FilePath $csc -Arguments $compilerArguments -Description "Launcher compilation"
    if (-not (Test-Path -LiteralPath $launcherOutput -PathType Leaf) -or (Get-Item -LiteralPath $launcherOutput).Length -eq 0) {
        throw "Launcher compilation did not produce Launcher.exe."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

    Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $iexpressSource "payload.zip") -Force
    Copy-Item -LiteralPath $installScript -Destination (Join-Path $iexpressSource "install.ps1") -Force

    $sedPath = Join-Path $workRoot "ZaoluRace.sed"
    $sourceWithSlash = $iexpressSource.TrimEnd("\") + "\"
    $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$candidateSetupPath
FriendlyName=Zaolu Race Setup
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -PayloadPath payload.zip
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
FILE0="payload.zip"
FILE1="install.ps1"

[SourceFiles]
SourceFiles0=$sourceWithSlash

[SourceFiles0]
%FILE0%=
%FILE1%=
"@
    Set-Content -LiteralPath $sedPath -Value $sed -Encoding Default

    $iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
    if (-not (Test-Path -LiteralPath $iexpress -PathType Leaf)) {
        throw "Windows IExpress was not found: $iexpress"
    }
    & $iexpress "/N" "/Q" $sedPath
    $iexpressExitCode = $LASTEXITCODE
    $temporaryDdf = Join-Path $workRoot "~ZaoluRace-Setup.DDF"
    $minimumCandidateLength = [int64][Math]::Floor((Get-Item -LiteralPath $payloadZip).Length * 0.90)
    $iexpressDeadline = [DateTime]::UtcNow.AddSeconds(90)
    $lastCandidateLength = -1L
    $stableCandidateChecks = 0
    $candidateReady = $false
    do {
        $currentCandidateLength = 0L
        if (Test-Path -LiteralPath $candidateSetupPath -PathType Leaf) {
            $currentCandidateLength = (Get-Item -LiteralPath $candidateSetupPath).Length
        }
        if (
            $currentCandidateLength -ge $minimumCandidateLength -and
            -not (Test-Path -LiteralPath $temporaryDdf) -and
            $currentCandidateLength -eq $lastCandidateLength
        ) {
            $stableCandidateChecks++
        }
        else {
            $stableCandidateChecks = 0
        }
        $lastCandidateLength = $currentCandidateLength
        $candidateReady = $stableCandidateChecks -ge 4
        if ($candidateReady) { break }
        Start-Sleep -Milliseconds 500
    }
    while ([DateTime]::UtcNow -lt $iexpressDeadline)

    if (-not $candidateReady) {
        throw "IExpress packaging failed with exit code $iexpressExitCode."
    }
    if ($iexpressExitCode -ne 0) {
        Write-Warning (
            "IExpress returned exit code {0} before its background compression completed; " +
            "the completed candidate will be verified before publishing." -f $iexpressExitCode
        )
    }

    if (-not (Test-Path -LiteralPath $candidateSetupPath -PathType Leaf) -or (Get-Item -LiteralPath $candidateSetupPath).Length -eq 0) {
        throw "IExpress did not produce the setup executable."
    }
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    Copy-Item -LiteralPath $candidateSetupPath -Destination $publishCandidate -Force
    $candidateHash = (Get-FileHash -LiteralPath $candidateSetupPath -Algorithm SHA256).Hash
    $publishHash = (Get-FileHash -LiteralPath $publishCandidate -Algorithm SHA256).Hash
    if ($candidateHash -cne $publishHash) {
        throw "The release candidate failed copy verification."
    }

    if (Test-Path -LiteralPath $setupPath -PathType Leaf) {
        [System.IO.File]::Replace($publishCandidate, $setupPath, $previousSetupPath, $true)
        if (Test-Path -LiteralPath $previousSetupPath) {
            Remove-Item -LiteralPath $previousSetupPath -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        Move-Item -LiteralPath $publishCandidate -Destination $setupPath
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $releaseDirectory -Force)) {
        if (-not [string]::Equals($item.FullName, $setupPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
    }
    $releaseItems = @(Get-ChildItem -LiteralPath $releaseDirectory -Force)
    if ($releaseItems.Count -ne 1 -or $releaseItems[0].Name -cne "ZaoluRace-Setup.exe") {
        throw "The release directory must contain only ZaoluRace-Setup.exe."
    }

    $buildSucceeded = $true
    Write-Host "Created $setupPath"
}
finally {
    if (-not $buildSucceeded -and (Test-Path -LiteralPath $publishCandidate)) {
        Remove-Item -LiteralPath (Assert-ChildPath -Path $publishCandidate -Root $repoRoot) -Force -ErrorAction SilentlyContinue
    }
    if ($buildSucceeded -and -not $KeepWorkDirectory -and (Test-Path -LiteralPath $workRoot)) {
        Remove-Item -LiteralPath (Assert-ChildPath -Path $workRoot -Root $repoRoot) -Recurse -Force
    }
}
