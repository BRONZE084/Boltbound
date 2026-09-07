param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".runtime"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$serverEntry = Join-Path $projectRoot "server\index.js"
$cloudflaredPath = Join-Path $runtimeDir "cloudflared-windows-amd64.exe"
$pidFile = Join-Path $runtimeDir "online-supervisor.pid"
$publicUrlFile = Join-Path $runtimeDir "public-url.txt"
$tunnelStdoutLog = Join-Path $runtimeDir "tunnel.stdout.log"
$tunnelStderrLog = Join-Path $runtimeDir "tunnel.stderr.log"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
  throw "cloudflared is missing at $cloudflaredPath"
}

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    throw "The online supervisor is already running as PID $existingPid."
  }
}

Set-Content -LiteralPath $pidFile -Value $PID -Encoding ASCII
Remove-Item -LiteralPath $publicUrlFile -Force -ErrorAction SilentlyContinue

$serverProcess = $null
$tunnelProcess = $null
$serverHealthFailures = 0
$tunnelStartedAt = $null
$nextTunnelStartAt = [datetime]::MinValue

function Test-GameServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-GameServer {
  $previousPort = $env:PORT
  try {
    $env:PORT = [string]$Port
    return Start-Process -FilePath $nodePath `
      -ArgumentList @($serverEntry) `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput (Join-Path $runtimeDir "server.stdout.log") `
      -RedirectStandardError (Join-Path $runtimeDir "server.stderr.log") `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    $env:PORT = $previousPort
  }
}

function Start-PublicTunnel {
  Remove-Item -LiteralPath $publicUrlFile,$tunnelStdoutLog,$tunnelStderrLog `
    -Force -ErrorAction SilentlyContinue
  return Start-Process -FilePath $cloudflaredPath `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $tunnelStdoutLog `
    -RedirectStandardError $tunnelStderrLog `
    -WindowStyle Hidden `
    -PassThru
}

function Update-PublicUrl {
  try {
    $logPaths = @($tunnelStdoutLog, $tunnelStderrLog)
    $text = @($logPaths | ForEach-Object {
      if (Test-Path -LiteralPath $_) {
        Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue
      }
    }) -join "`n"
    $match = [regex]::Match(
      $text,
      "https://[a-z0-9-]+\.trycloudflare\.com\b",
      [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) { return $false }

    $currentUrl = Get-Content -LiteralPath $publicUrlFile -ErrorAction SilentlyContinue
    if ($currentUrl -ne $match.Value) {
      Set-Content -LiteralPath $publicUrlFile -Value $match.Value -Encoding ASCII
      Write-Output "Public URL: $($match.Value)"
    }
    return $true
  } catch {
    return $false
  }
}

try {
  while ($true) {
    $gameHealthy = Test-GameServer
    if ($gameHealthy) {
      $serverHealthFailures = 0
    } else {
      $serverHealthFailures++
      if ($null -eq $serverProcess -or $serverProcess.HasExited) {
        $serverProcess = Start-GameServer
        $serverHealthFailures = 0
      } elseif ($serverHealthFailures -ge 3) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(3000) | Out-Null
        $serverProcess = Start-GameServer
        $serverHealthFailures = 0
      }
    }

    if ($tunnelProcess -and $tunnelProcess.HasExited) {
      Write-Output "cloudflared exited with code $($tunnelProcess.ExitCode)."
      $tunnelProcess = $null
      $tunnelStartedAt = $null
      $nextTunnelStartAt = (Get-Date).AddSeconds(5)
      Remove-Item -LiteralPath $publicUrlFile -Force -ErrorAction SilentlyContinue
    }

    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
      $hasPublicUrl = Update-PublicUrl
      if (-not $hasPublicUrl -and $tunnelStartedAt -and ((Get-Date) - $tunnelStartedAt).TotalSeconds -ge 45) {
        Write-Output "cloudflared did not publish a URL within 45 seconds; restarting."
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
        $tunnelProcess.WaitForExit(3000) | Out-Null
        $tunnelProcess = $null
        $tunnelStartedAt = $null
        $nextTunnelStartAt = (Get-Date).AddSeconds(5)
        Remove-Item -LiteralPath $publicUrlFile -Force -ErrorAction SilentlyContinue
      }
    }

    if ($gameHealthy -and $null -eq $tunnelProcess -and (Get-Date) -ge $nextTunnelStartAt) {
      $tunnelProcess = Start-PublicTunnel
      $tunnelStartedAt = Get-Date
    }

    Start-Sleep -Seconds 5
  }
} finally {
  if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
    Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    $tunnelProcess.WaitForExit(3000) | Out-Null
  }
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    $serverProcess.WaitForExit(3000) | Out-Null
  }
  Remove-Item -LiteralPath $publicUrlFile,$pidFile -Force -ErrorAction SilentlyContinue
}
