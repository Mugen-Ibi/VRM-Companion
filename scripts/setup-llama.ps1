param([string]$Root = (Join-Path $env:LOCALAPPDATA 'VRM-Companion-LLM'), [string]$Build = 'stable', [string]$Cuda = '', [switch]$Activate)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if ($Build -notin @('stable','latest') -and $Build -notmatch '^b\d+$') { throw 'Specify stable, latest, or b<number>.' }
if ($Cuda -and $Cuda -notmatch '^\d+\.\d+$') { throw 'Invalid CUDA version.' }
$headers = @{ 'User-Agent' = 'llama-local-maintenance' }
if ($Build -eq 'stable') {
  $stable = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers $headers
  $tagAsset = $stable.assets | Where-Object name -EQ 'nightly-tag.txt' | Select-Object -First 1
  if (-not $tagAsset) { throw 'Stable release has no nightly-tag.txt; inspect the official release manually.' }
  $content = (Invoke-WebRequest $tagAsset.browser_download_url -Headers $headers).Content
  if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
  $Build = $content.Trim()
  if ($Build -notmatch '^b\d+$') { throw 'Invalid stable build mapping.' }
} elseif ($Build -eq 'latest') {
  $releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=100' -Headers $headers
  $Build = ($releases | Where-Object { $_.tag_name -match '^b\d+$' -and -not $_.draft } |
    Sort-Object { [int]$_.tag_name.Substring(1) } -Descending | Select-Object -First 1).tag_name
  if (-not $Build) { throw 'No numbered build found.' }
}
$release = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Build" -Headers $headers
if (-not $Cuda) {
  $Cuda = $release.assets.name | ForEach-Object {
    if ($_ -match '^llama-b\d+-bin-win-cuda-(\d+\.\d+)-x64\.zip$') { $Matches[1] }
  } | Sort-Object { [version]$_ } -Descending | Select-Object -First 1
}
if (-not $Cuda) { throw 'No Windows x64 CUDA package found.' }
$version = "$Build-cuda$Cuda"
$target = Join-Path $Root "releases/$version"
$cache = Join-Path $Root 'cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$names = @("llama-$Build-bin-win-cuda-$Cuda-x64.zip", "cudart-llama-bin-win-cuda-$Cuda-x64.zip")
$assets = @()
foreach ($name in $names) {
  $asset = $release.assets | Where-Object name -EQ $name | Select-Object -First 1
  if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Missing asset or SHA-256: $name" }
  $archive = Join-Path $cache $name
  if (-not (Test-Path -LiteralPath $archive)) {
    $partial = "$archive.partial"
    Invoke-WebRequest $asset.browser_download_url -OutFile $partial -Headers $headers
    Move-Item -LiteralPath $partial -Destination $archive
  }
  $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ("sha256:$digest" -ne $asset.digest) { throw "Checksum mismatch: $archive. Remove this archive and retry." }
  $assets += @{ name = $name; sha256 = $digest; url = $asset.browser_download_url }
}
if (-not (Test-Path -LiteralPath $target)) {
  $stage = Join-Path $Root ("releases/.staging-" + [guid]::NewGuid().ToString('N'))
  $bin = Join-Path $stage 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  foreach ($name in $names) { Expand-Archive -LiteralPath (Join-Path $cache $name) -DestinationPath $bin -Force }
  $server = Join-Path $bin 'llama-server.exe'
  if (-not (Test-Path $server)) { throw "Unexpected archive layout in $stage" }
  $versionOutput = & $server --version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "(?:version: |build )$($Build.Substring(1))\b") { throw "Version check failed: $versionOutput" }
  $devices = & $server --list-devices 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $devices -notmatch 'CUDA0') { throw "CUDA check failed. Check NVIDIA driver compatibility: $devices" }
  $files = @(Get-ChildItem -LiteralPath $bin -File | ForEach-Object { @{ name = $_.Name; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
  @{ build = $Build; cuda = $Cuda; version = $version; release = $release.html_url; stableTag = $stable.tag_name; files = $files;
     installedAt = [DateTime]::UtcNow.ToString('o'); assets = $assets; versionOutput = $versionOutput; devices = $devices } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding utf8
  Move-Item -LiteralPath $stage -Destination $target
} else {
  $installed = Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw | ConvertFrom-Json
  if ($installed.version -ne $version) { throw 'Existing installation manifest does not match.' }
  if (-not $installed.files) { throw 'Existing installation has no file checksums.' }
  foreach ($file in $installed.files) {
    if ([IO.Path]::GetFileName($file.name) -ne $file.name) { throw 'Invalid manifest filename.' }
    if ((Get-FileHash (Join-Path $target "bin/$($file.name)") -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Installed file checksum mismatch: $($file.name)" }
  }
}
# Standalone copies work even without the Companion checkout. Originals are versioned in that project.
$scripts = Join-Path $Root 'scripts'
New-Item -ItemType Directory -Force -Path $scripts | Out-Null
foreach ($name in @('setup-llama.ps1', 'use-llama.ps1', 'start-llama.ps1', 'stop-llama.ps1', 'compare-llama.ps1', 'compare-llama-server.ps1')) {
  $source = Join-Path $PSScriptRoot $name
  $destination = Join-Path $scripts $name
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) { Copy-Item -LiteralPath $source -Destination $destination -Force }
}
Write-Output "Installed $version at $target"
if ($Activate) { & (Join-Path $PSScriptRoot 'use-llama.ps1') -Root $Root -Version $version }
else { Write-Output 'Active version unchanged. Compare performance, stop the server, then run use-llama.ps1 -Version <version>.' }
