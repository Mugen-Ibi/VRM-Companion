param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'VRM-Companion-LLM'), [string]$Model = '', [string]$Version = '',
  [ValidateRange(1024,65535)][int]$Port = 8080,
  [ValidateRange(0,999)][int]$GpuLayers = 99,
  [ValidateRange(1024,1048576)][int]$Context = 16384
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $Model) { throw 'Specify the GGUF model with -Model.' }
if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw 'GGUF model not found. Specify -Model.' }
$directory = Join-Path $Root 'llama'
if ($Version) {
  if ($Version -notmatch '^b\d+-cuda\d+\.\d+$') { throw 'Invalid version.' }
  $directory = Join-Path $Root "releases/$Version/bin"
}
$server = Join-Path $directory 'llama-server.exe'
if (-not (Test-Path -LiteralPath $server)) { throw 'Run setup-llama.ps1 and use-llama.ps1 first.' }
if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains $Port) { throw "Port $Port is already in use." }
$logs = Join-Path $Root 'logs'
$run = Join-Path $Root 'run'
New-Item -ItemType Directory -Path $logs,$run -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outLog = Join-Path $logs "llama-$Port-$stamp.out.log"
$errLog = Join-Path $logs "llama-$Port-$stamp.err.log"
$arguments = @('-m', ('"' + [IO.Path]::GetFullPath($Model) + '"'), '--host', '127.0.0.1', '--port', "$Port", '-c', "$Context", '-ngl', "$GpuLayers", '-np', '1', '--jinja', '--temp', '0.3', '--top-p', '0.9', '--repeat-penalty', '1.1')
$proc = Start-Process -FilePath $server -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
@{ pid = $proc.Id; startedAt = $proc.StartTime.ToUniversalTime().ToString('o'); executable = $proc.Path; port = $Port; model = $Model; context = $Context; stdout = $outLog; stderr = $errLog } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run "llama-$Port.json") -Encoding utf8
try {
  $deadline = (Get-Date).AddMinutes(3)
  do {
    $proc.Refresh()
    if ($proc.HasExited) { throw "Server exited ($($proc.ExitCode)). See $errLog" }
    try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 } catch { $health = $null }
    if ($health.status -eq 'ok') { Write-Output "Ready: http://127.0.0.1:$Port (PID $($proc.Id)). Log: $errLog"; return }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw "Server readiness timed out. See $errLog"
} catch {
  if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit() }
  throw
}
