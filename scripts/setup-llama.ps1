param([string]$Build = 'b10964')
$ErrorActionPreference = 'Stop'
if ($Build -notmatch '^b[0-9]+$') { throw 'Use a numbered official release tag.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath((Join-Path $workspace ".local/llama/$Build"))
if (-not $target.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid destination.' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Build" -Headers @{ 'User-Agent' = 'VRM-Companion-setup' }
$names = @("llama-$Build-bin-win-cuda-13.3-x64.zip", 'cudart-llama-bin-win-cuda-13.3-x64.zip')
$manifest = @()
foreach ($name in $names) {
  $asset = $release.assets | Where-Object name -EQ $name | Select-Object -First 1
  if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Missing SHA-256 for $name" }
  $archive = Join-Path $target $name
  if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive }
  $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ("sha256:$digest" -ne $asset.digest) { throw "Checksum mismatch: $name" }
  Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
  $manifest += @{ name = $name; sha256 = $digest; url = $asset.browser_download_url }
  Write-Output "Verified and extracted $name"
}
@{ build = $Build; release = $release.html_url; downloadedAt = [DateTime]::UtcNow.ToString('o'); assets = $manifest } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'manifest.json') -Encoding utf8
Write-Output "Installed official binaries at $target"
