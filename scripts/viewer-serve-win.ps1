# Evolution viewer in a standalone PowerShell window (not tied to Cursor background shells).
param([switch]$Launch)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ($Launch) {
  Start-Process powershell.exe -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy', 'Bypass',
    '-File', $PSCommandPath
  ) | Out-Null
  Write-Host "Evolution viewer starting in a new PowerShell window."
  Write-Host "Close that window or Ctrl+C there to stop the server."
  exit 0
}

Set-Location $RepoRoot
npm run viewer:serve
