[CmdletBinding()]
param([switch]$Quiet)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$testMode = $env:ZAOLU_INSTALL_TEST -eq "1"
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
            throw "Refusing unsafe test uninstall path: $testRoot"
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
        throw "Refusing unsafe uninstall path: $installRoot"
    }
    return $installRoot
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

try {
    Add-Type -AssemblyName System.Windows.Forms
    if (-not $Quiet) {
        $answer = [System.Windows.Forms.MessageBox]::Show("Remove Zaolu Race from this computer?", "Uninstall Zaolu Race", "YesNo", "Question")
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
    }

    $installRoot = Get-InstallRoot
    $testMarkerPath = Join-Path $installRoot $testMarkerName
    if ($testMode -and -not (Test-Path -LiteralPath $testMarkerPath -PathType Leaf)) {
        throw "Refusing unmarked test uninstall directory: $installRoot"
    }
    Stop-InstalledProcesses -Root $installRoot
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force
    }

    if (-not $testMode) {
        $desktopShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) "Zaolu Race.lnk"
        $startMenuDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) "ZaoluRace"
        $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZaoluRace"
        if (Test-Path -LiteralPath $desktopShortcut) { Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $startMenuDirectory) { Remove-Item -LiteralPath $startMenuDirectory -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not $Quiet) {
        [void][System.Windows.Forms.MessageBox]::Show("Zaolu Race was removed.", "Uninstall Zaolu Race", "OK", "Information")
    }
}
catch {
    $failure = $_
    if ($testMode) {
        Write-Error $failure
        exit 1
    }
    if (-not $Quiet) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show("Uninstall failed.`r`n`r`n$($_.Exception.Message)", "Uninstall Zaolu Race", "OK", "Error")
        }
        catch { Write-Error $_ }
    }
    exit 1
}
