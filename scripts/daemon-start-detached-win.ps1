# Start jea daemon in a detached OS process (survives Cursor agent / background shell exit).
param(
  [string]$Subject = 'agentank-tank',
  [ValidateSet('all', 'cycle', 'channel')]
  [string]$Domain = 'all',
  [switch]$StopFirst,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $RepoRoot 'runtime\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stdoutLog = Join-Path $LogDir "daemon-$Subject.stdout.log"
$stderrLog = Join-Path $LogDir "daemon-$Subject.stderr.log"

Set-Location $RepoRoot

$jea = Join-Path $RepoRoot 'src\cli\jea.mjs'
function Invoke-Jea {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & node --preserve-symlinks $jea @Args
}

function Get-WorkerRunning {
  $json = Invoke-Jea daemon status --subject $Subject --json 2>$null
  if (-not $json) { return $false }
  try {
    $doc = ($json -join "`n") | ConvertFrom-Json
    return [bool]$doc.worker.running -and [bool]$doc.worker.pid_alive
  } catch {
    return $false
  }
}

if ($StopFirst -or ($Force -and (Get-WorkerRunning))) {
  Invoke-Jea daemon stop --subject $Subject | Out-Host
  foreach ($i in 1..45) {
    if (-not (Get-WorkerRunning)) { break }
    Start-Sleep -Seconds 1
  }
}

if ((Get-WorkerRunning) -and -not $Force) {
  Write-Host "Daemon already running for subject '$Subject'. Use -Force to restart."
  exit 0
}

$jeaArgs = @(
  '--preserve-symlinks',
  (Join-Path $RepoRoot 'src\cli\jea.mjs'),
  'daemon', 'start',
  '--subject', $Subject
)
if ($Domain -ne 'all') {
  $jeaArgs += @('--domain', $Domain)
}

$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node `
  -ArgumentList $jeaArgs `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog | Out-Null

$healthy = $false
foreach ($i in 1..30) {
  if (Get-WorkerRunning) {
    $healthy = $true
    break
  }
  Start-Sleep -Seconds 1
}

if ($healthy) {
  Write-Host "Daemon started detached for subject '$Subject' (domain=$Domain)."
  Write-Host "Logs: $stdoutLog"
  Write-Host "      $stderrLog"
  Write-Host "Stop: node --preserve-symlinks src/cli/jea.mjs daemon stop --subject $Subject"
  exit 0
}

Write-Host "Daemon process launched but worker not healthy yet. Check logs:"
Write-Host "  $stderrLog"
exit 1
