param([string]$Root = 'D:\LLM', [string]$StableVersion = 'b10964-cuda13.3', [string]$LatestVersion = 'b11050-cuda13.4')
$ErrorActionPreference = 'Stop'
$output = Join-Path $Root ('benchmarks/server-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $output | Out-Null
if (Get-Process llama-server -ErrorAction SilentlyContinue) { throw 'Stop existing servers first.' }
$rows = @()
foreach ($version in @($StableVersion,$LatestVersion,$LatestVersion,$StableVersion)) {
  & (Join-Path $PSScriptRoot 'start-llama.ps1') -Root $Root -Version $version -Port 8081 -Context 16384
  try {
    for ($i = 0; $i -lt 4; $i++) {
      $body = @{ prompt = ('Explain how to organize local project files by extension while preserving the originals. ' * 100);
        n_predict = 128; ignore_eos = $true; cache_prompt = $false; temperature = 0; seed = 1234 } | ConvertTo-Json
      $watch = [Diagnostics.Stopwatch]::StartNew()
      $result = Invoke-RestMethod http://127.0.0.1:8081/completion -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
      $watch.Stop()
      if ($i -gt 0) {
        $rows += @{ version = $version; elapsedMs = $watch.Elapsed.TotalMilliseconds; timings = $result.timings }
      }
    }
  } finally { & (Join-Path $PSScriptRoot 'stop-llama.ps1') -Root $Root -Port 8081 }
  $rows | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $output 'results.json') -Encoding utf8
  Write-Output "Measured API: $version"
}
$rows | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $output 'results.json') -Encoding utf8
$rows | Group-Object version | ForEach-Object {
  [pscustomobject]@{ version = $_.Name; samples = $_.Count;
    promptTokensPerSecond = ($_.Group.timings.prompt_per_second | Measure-Object -Average).Average;
    generatedTokensPerSecond = ($_.Group.timings.predicted_per_second | Measure-Object -Average).Average;
    elapsedMs = ($_.Group.elapsedMs | Measure-Object -Average).Average }
} | Tee-Object -Variable summary | Format-Table
$summary | ConvertTo-Json | Set-Content (Join-Path $output 'summary.json') -Encoding utf8
Write-Output "Results: $output"
