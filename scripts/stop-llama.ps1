param([string]$Root = (Join-Path $env:LOCALAPPDATA 'VRM-Companion-LLM'), [ValidateRange(1024,65535)][int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $Root "run/llama-$Port.json"
if (-not (Test-Path -LiteralPath $statePath)) { throw 'No managed server record. Stop manually launched servers from their original terminal.' }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$proc = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
if ($proc) {
  if ($proc.StartTime.ToUniversalTime() -ne ([DateTime]$state.startedAt).ToUniversalTime() -or $proc.Path -ne $state.executable) { throw 'Process identity changed; refusing to stop it.' }
  Stop-Process -InputObject $proc
  $proc.WaitForExit()
}
Remove-Item -LiteralPath $statePath
Write-Output "Stopped managed server on port $Port."
