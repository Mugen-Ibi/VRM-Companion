param([string]$Root = 'D:\LLM', [string]$Model = 'D:\LLM\models\Qwen3.5-9B-Q4_K_M.gguf',
  [string]$StableVersion = 'b10964-cuda13.3', [string]$LatestVersion = 'b11050-cuda13.4')
$ErrorActionPreference = 'Stop'
foreach ($version in @($StableVersion,$LatestVersion)) { if ($version -notmatch '^b\d+-cuda\d+\.\d+$') { throw 'Invalid version.' } }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $Root "benchmarks/$stamp"
New-Item -ItemType Directory -Force -Path $output | Out-Null
if (Get-Process llama-server -ErrorAction SilentlyContinue) { throw 'Stop llama-server before benchmarking to free GPU memory.' }
# Alternate order ABBA to reduce thermal and ordering bias. Each case has warmup and five repetitions.
$order = @($StableVersion,$LatestVersion,$LatestVersion,$StableVersion)
@{ date = [DateTime]::UtcNow.ToString('o'); model = $Model; modelSha256 = (Get-FileHash $Model -Algorithm SHA256).Hash;
   order = $order; repetitions = 5; warmup = $true; gpuLayers = 99; threads = 8; flashAttention = 'on'; batch = 512; ubatch = 512;
   cacheK = 'f16'; cacheV = 'f16'; prompt = @(512,2048); generation = 128; depth = 0;
   gpu = (& nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit --format=csv | Out-String) } |
  ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'environment.json') -Encoding utf8
for ($i = 0; $i -lt $order.Count; $i++) {
  $version = $order[$i]
  $exe = Join-Path $Root "releases/$version/bin/llama-bench.exe"
  $prefix = Join-Path $output "$i-$version"
  & nvidia-smi --query-gpu=temperature.gpu,power.draw,memory.used,clocks.sm --format=csv | Set-Content "$prefix-gpu-before.csv"
  $proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru -ArgumentList @(
    '-m', ('"' + $Model + '"'), '-p', '512,2048', '-n', '128', '-r', '5', '-ngl', '99', '-fa', 'on', '-t', '8', '-b', '512', '-ub', '512', '-ctk', 'f16', '-ctv', 'f16', '-o', 'json'
  ) -RedirectStandardOutput "$prefix.json" -RedirectStandardError "$prefix.err.log"
  if (-not $proc.WaitForExit(600000)) { $proc.Kill(); throw "Benchmark timeout: $version" }
  if ($proc.ExitCode -ne 0) { throw "Benchmark failed: $prefix.err.log" }
  Write-Output "Completed $($i + 1)/4: $version"
}
$rows = foreach ($file in Get-ChildItem $output -Filter '*-cuda*.json') {
  Get-Content $file.FullName -Raw | ConvertFrom-Json
}
$summary = $rows | Group-Object build_commit,n_prompt,n_gen | ForEach-Object {
  $sample = $_.Group[0]
  $values = @($_.Group | ForEach-Object { $_.samples_ts } | Sort-Object)
  [pscustomobject]@{ build = $sample.build_number; commit = $sample.build_commit; prompt = $sample.n_prompt; generation = $sample.n_gen;
    samples = $values.Count; meanTokensPerSecond = ($values | Measure-Object -Average).Average;
    medianTokensPerSecond = ($values[[int]($values.Count / 2) - 1] + $values[[int]($values.Count / 2)]) / 2;
    minTokensPerSecond = $values[0]; maxTokensPerSecond = $values[-1] }
}
$summary | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'summary.json') -Encoding utf8
$summary | Format-Table
Write-Output "Results: $output"
