[CmdletBinding()]
param(
    [string]$PayloadPath = (Join-Path $PSScriptRoot "payload.zip")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$testMode = $env:ZAOLU_INSTALL_TEST -eq "1"
$skipLaunch = $testMode -or $env:ZAOLU_INSTALL_NO_LAUNCH -eq "1"
$testMarkerName = ".zaolu-install-test-root"

function Get-InstallRoot {
    if ($script:testMode) {
        if ([string]::IsNullOrWhiteSpace($env:ZAOLU_INSTALL_ROOT)) {
            throw "ZAOLU_INSTALL_ROOT is required when ZAOLU_INSTALL_TEST=1."
        }
        $testRoot = [System.IO.Path]::GetFullPath($env:ZAOLU_INSTALL_ROOT).TrimEnd("\")
        $driveRoot = [System.IO.Path]::GetPathRoot($testRoot).TrimEnd("\")
        if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetFileName($testRoot)) -or
            [string]::Equals($testRoot, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing unsafe test installation path: $testRoot"
        }
        return $testRoot
    }

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is not available."
    }
    $localRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\")
    $installRoot = [System.IO.Path]::GetFullPath((Join-Path $localRoot "ZaoluRace")).TrimEnd("\")
    if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($installRoot), $localRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($installRoot) -cne "ZaoluRace") {
        throw "Refusing unsafe installation path: $installRoot"
    }
    return $installRoot
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside the installation directory: $fullPath"
    }
    return $fullPath
}

function Stop-InstalledProcesses {
    param([Parameter(Mandatory = $true)][string]$Root)

    $prefix = $Root.TrimEnd("\") + "\"
    $candidateNames = @("Launcher.exe", "node.exe", "cloudflared.exe")
    for ($pass = 0; $pass -lt 4; $pass++) {
        $matches = @(
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $candidateNames -contains $_.Name } |
                ForEach-Object {
                    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { return }
                    try { $executablePath = [System.IO.Path]::GetFullPath($_.ExecutablePath) } catch { return }
                    if ($executablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $_ }
                } |
                Sort-Object @{ Expression = { if ($_.Name -ieq "Launcher.exe") { 0 } else { 1 } } }
        )
        if ($matches.Count -eq 0) { break }
        foreach ($process in $matches) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 300
    }
}

function New-Shortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [string]$Arguments = "",
        [string]$WorkingDirectory = "",
        [string]$IconLocation = ""
    )
    New-Item -ItemType Directory -Path (Split-Path -Parent $ShortcutPath) -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        try {
            $shortcut.TargetPath = $TargetPath
            $shortcut.Arguments = $Arguments
            $shortcut.WorkingDirectory = $WorkingDirectory
            if (-not [string]::IsNullOrWhiteSpace($IconLocation)) { $shortcut.IconLocation = $IconLocation }
            $shortcut.Save()
        }
        finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    }
    finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

$installRoot = Get-InstallRoot
$incomingRoot = $null
$backupRoot = $null
$testMarkerPath = $null
$installRootExisted = Test-Path -LiteralPath $installRoot -PathType Container
$testMarkerExisted = $false
$replacementNames = New-Object System.Collections.Generic.List[string]
$oldFilesMoved = $false
$replacementCommitted = $false

try {
    if (-not (Test-Path -LiteralPath $PayloadPath -PathType Leaf)) {
        throw "Installer payload was not found: $PayloadPath"
    }
    $resolvedPayload = (Resolve-Path -LiteralPath $PayloadPath).Path
    $testMarkerPath = Assert-ChildPath -Path (Join-Path $installRoot $testMarkerName) -Root $installRoot
    if ($testMode -and $installRootExisted) {
        $testMarkerExisted = Test-Path -LiteralPath $testMarkerPath -PathType Leaf
        $existingTestItems = @(Get-ChildItem -LiteralPath $installRoot -Force)
        if ($existingTestItems.Count -gt 0 -and -not (Test-Path -LiteralPath $testMarkerPath -PathType Leaf)) {
            throw "Refusing unmarked test installation directory: $installRoot"
        }
    }
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    if ($testMode) {
        Set-Content -LiteralPath $testMarkerPath -Value "ZaoluRace installer test root" -Encoding ASCII
    }
    $incomingRoot = Assert-ChildPath -Path (Join-Path $installRoot (".install-" + [guid]::NewGuid().ToString("N"))) -Root $installRoot
    $backupRoot = Assert-ChildPath -Path (Join-Path $installRoot (".backup-" + [guid]::NewGuid().ToString("N"))) -Root $installRoot
    New-Item -ItemType Directory -Path $incomingRoot -Force | Out-Null
    Expand-Archive -LiteralPath $resolvedPayload -DestinationPath $incomingRoot -Force

    foreach ($relativePath in @("Launcher.exe", "runtime\node.exe", "runtime\cloudflared.exe", "uninstall.ps1", "app\package.json", "app\package-lock.json", "app\server\index.js")) {
        if (-not (Test-Path -LiteralPath (Join-Path $incomingRoot $relativePath) -PathType Leaf)) {
            throw "Installer payload is incomplete: $relativePath"
        }
    }
    foreach ($relativePath in @("app\dist", "app\shared", "app\node_modules")) {
        if (-not (Test-Path -LiteralPath (Join-Path $incomingRoot $relativePath) -PathType Container)) {
            throw "Installer payload is incomplete: $relativePath"
        }
    }

    Stop-InstalledProcesses -Root $installRoot
    $existingItems = @(Get-ChildItem -LiteralPath $installRoot -Force | Where-Object {
        -not [string]::Equals($_.FullName, $incomingRoot, [System.StringComparison]::OrdinalIgnoreCase)
    })
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $oldFilesMoved = $true
    foreach ($item in $existingItems) {
        $destination = Assert-ChildPath -Path (Join-Path $backupRoot $item.Name) -Root $installRoot
        Move-Item -LiteralPath $item.FullName -Destination $destination -Force
    }

    foreach ($item in @(Get-ChildItem -LiteralPath $incomingRoot -Force)) {
        $replacementNames.Add($item.Name)
        Move-Item -LiteralPath $item.FullName -Destination $installRoot -Force
    }
    Remove-Item -LiteralPath $incomingRoot -Force

    if ($testMode) {
        Set-Content -LiteralPath $testMarkerPath -Value "ZaoluRace installer test root" -Encoding ASCII
    }
    $launcherPath = Join-Path $installRoot "Launcher.exe"
    if (-not $skipLaunch) {
        Start-Process -FilePath $launcherPath -WorkingDirectory $installRoot
    }
    $replacementCommitted = $true
    Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue

    if (-not $testMode) {
        try {
        $uninstallScript = Join-Path $installRoot "uninstall.ps1"
        $desktopShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) "Zaolu Race.lnk"
        $startMenuDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) "ZaoluRace"
        New-Shortcut -ShortcutPath $desktopShortcut -TargetPath $launcherPath -WorkingDirectory $installRoot -IconLocation "$launcherPath,0"
        New-Shortcut -ShortcutPath (Join-Path $startMenuDirectory "Zaolu Race.lnk") -TargetPath $launcherPath -WorkingDirectory $installRoot -IconLocation "$launcherPath,0"
        New-Shortcut -ShortcutPath (Join-Path $startMenuDirectory "Uninstall Zaolu Race.lnk") `
            -TargetPath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Arguments ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $uninstallScript) `
            -WorkingDirectory $env:TEMP

        $package = Get-Content -LiteralPath (Join-Path $installRoot "app\package.json") -Raw | ConvertFrom-Json
        $estimatedSize = [int][Math]::Ceiling(((Get-ChildItem -LiteralPath $installRoot -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum) / 1KB)
        $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZaoluRace"
        New-Item -Path $uninstallKey -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "Zaolu Race" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value ([string]$package.version) -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "Publisher" -Value "Zaolu Race" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $installRoot -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "DisplayIcon" -Value "$launcherPath,0" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value ("`"{0}`" -NoProfile -ExecutionPolicy Bypass -File `"{1}`"" -f "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe", $uninstallScript) -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "QuietUninstallString" -Value ("`"{0}`" -NoProfile -ExecutionPolicy Bypass -File `"{1}`" -Quiet" -f "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe", $uninstallScript) -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $uninstallKey -Name "EstimatedSize" -Value $estimatedSize -PropertyType DWord -Force | Out-Null
        }
        catch {
            $integrationMessage = "Zaolu Race was installed, but Windows shortcuts or the uninstall entry could not be updated.`r`n`r`n$($_.Exception.Message)"
            try {
                Add-Type -AssemblyName System.Windows.Forms
                [void][System.Windows.Forms.MessageBox]::Show($integrationMessage, "Zaolu Race Setup", "OK", "Warning")
            }
            catch { Write-Warning $integrationMessage }
        }
    }
}
catch {
    $failure = $_
    if ($oldFilesMoved -and -not $replacementCommitted -and $backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        foreach ($name in $replacementNames) {
            $replacementPath = Assert-ChildPath -Path (Join-Path $installRoot $name) -Root $installRoot
            if (Test-Path -LiteralPath $replacementPath) {
                Remove-Item -LiteralPath $replacementPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $backupRoot -Force -ErrorAction SilentlyContinue)) {
            Move-Item -LiteralPath $item.FullName -Destination $installRoot -Force -ErrorAction SilentlyContinue
        }
    }
    if ($incomingRoot -and (Test-Path -LiteralPath $incomingRoot)) {
        Remove-Item -LiteralPath $incomingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($backupRoot -and (Test-Path -LiteralPath $backupRoot) -and -not $replacementCommitted -and
        @(Get-ChildItem -LiteralPath $backupRoot -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $backupRoot -Force -ErrorAction SilentlyContinue
    }
    if ($testMode) {
        Write-Error $failure
        exit 1
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("Zaolu Race installation failed.`r`n`r`n$($failure.Exception.Message)", "Zaolu Race Setup", "OK", "Error")
    }
    catch { Write-Error $failure }
    exit 1
}
