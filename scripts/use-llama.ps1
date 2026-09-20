param([string]$Root = (Join-Path $env:LOCALAPPDATA 'VRM-Companion-LLM'), [Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^b\d+-cuda\d+\.\d+$') { throw 'Invalid version; use b11050-cuda13.4.' }
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$bin = Join-Path $Root "releases/$Version/bin"
if (-not (Test-Path -LiteralPath (Join-Path $bin 'llama-server.exe'))) { throw 'Install this version first.' }
$link = Join-Path $Root 'llama'
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -like '*llama*' -and $_.Path -and $_.Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count) { throw "Stop llama processes under $Root before switching: $($running.Id -join ', ')" }
$item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
$oldTarget = $null
if ($item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  $backup = Join-Path $Root ('backups/legacy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  if (-not $item.FullName.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFullPath($backup).StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe migration path.' }
  Move-Item -LiteralPath $link -Destination (Join-Path $backup 'llama')
  Write-Output "Original binaries preserved in $backup"
} elseif ($item) {
  if ($item.LinkType -ne 'Junction') { throw 'Expected a directory or junction at llama.' }
  $oldTarget = @($item.Target)[0]
  # Non-recursive removal affects only the junction, never the target directory.
  [IO.Directory]::Delete($link)
}
try { New-Item -ItemType Junction -Path $link -Target $bin | Out-Null }
catch {
  if ($backup) { Move-Item -LiteralPath (Join-Path $backup 'llama') -Destination $link }
  elseif ($oldTarget) { New-Item -ItemType Junction -Path $link -Target $oldTarget | Out-Null }
  throw
}
Write-Output "Active: $Version ($link -> $bin)"
