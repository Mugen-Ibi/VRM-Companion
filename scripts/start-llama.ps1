param(
  [string]$Model = 'D:\LLM\models\Qwen3.5-9B-Q4_K_M.gguf',
  [string]$Build = 'b10964',
  [int]$Port = 8080,
  [int]$GpuLayers = 99,
  [int]$Context = 4096
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Build -notmatch '^b[0-9]+$' -or $Port -lt 1024 -or $Port -gt 65535 -or $GpuLayers -lt 0 -or $Context -lt 1024) { throw 'Invalid server options.' }
if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw 'GGUF model not found. Specify -Model.' }
$directory = Join-Path $workspace ".local/llama/$Build"
$server = Get-ChildItem -LiteralPath $directory -Recurse -Filter llama-server.exe | Select-Object -First 1
if (-not $server) { throw 'Run scripts/setup-llama.ps1 first.' }
$logs = Join-Path $workspace '.local/logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
# Start only a new owned process. An existing server is never killed or reconfigured.
$arguments = @('-m', ('"' + [IO.Path]::GetFullPath($Model) + '"'), '--host', '127.0.0.1', '--port', "$Port", '-c', "$Context", '-ngl', "$GpuLayers", '-np', '1', '--jinja')
$dllDirs = @(Get-ChildItem -LiteralPath $directory -Recurse -Filter '*.dll' | Select-Object -ExpandProperty DirectoryName -Unique)
$originalPath = $env:PATH
try {
  $env:PATH = ($dllDirs -join ';') + ';' + $originalPath
  $proc = Start-Process -FilePath $server.FullName -ArgumentList $arguments -WorkingDirectory $server.DirectoryName -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "llama-$Port.out.log") -RedirectStandardError (Join-Path $logs "llama-$Port.err.log")
  Write-Output "Started llama-server PID $($proc.Id), endpoint http://127.0.0.1:$Port. Logs: $logs"
} finally { $env:PATH = $originalPath }
