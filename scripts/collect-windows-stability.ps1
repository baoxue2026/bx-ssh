[CmdletBinding()]
param(
  [string]$ProcessName = "bx-ssh-desktop",
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [double]$DurationHours = 24,
  [int]$SampleIntervalSeconds = 60,
  [string]$RunId = "",
  [string]$Commit = "",
  [string]$BaselineCommit = ""
)

$ErrorActionPreference = "Stop"
if ($DurationHours -le 0) { throw "DurationHours must be positive" }
if ($SampleIntervalSeconds -le 0) { throw "SampleIntervalSeconds must be positive" }

$resolvedOutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
$memoryPath = Join-Path $resolvedOutputDir "process-memory.csv"
$handlesPath = Join-Path $resolvedOutputDir "handle-snapshots.jsonl"
$eventsPath = Join-Path $resolvedOutputDir "lifecycle-events.jsonl"
$metadataPath = Join-Path $resolvedOutputDir "run-metadata.json"
$startedAt = [DateTime]::UtcNow
$deadline = $startedAt.AddHours($DurationHours)
if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = "windows-$($startedAt.ToString('yyyyMMddTHHmmssZ'))"
}

"timestampUtc,workingSetMb,handleCount,processCount,pids" | Set-Content -LiteralPath $memoryPath -Encoding utf8NoBOM
@{ timestampUtc = $startedAt.ToString("o"); event = "collector_started"; processName = $ProcessName } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $eventsPath -Encoding utf8NoBOM

function Get-RelatedProcessSnapshot {
  param([Parameter(Mandatory = $true)][string]$Name)

  $processes = @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -ieq "$Name.exe" -or $_.Name -ieq $Name
    })
  if ($processes.Count -eq 0) { return @() }

  $all = @(Get-CimInstance Win32_Process)
  $ids = [System.Collections.Generic.HashSet[uint32]]::new()
  $queue = [System.Collections.Generic.Queue[uint32]]::new()
  foreach ($process in $processes) {
    [void]$ids.Add([uint32]$process.ProcessId)
    $queue.Enqueue([uint32]$process.ProcessId)
  }
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parentId }) {
      $childId = [uint32]$child.ProcessId
      if ($ids.Add($childId)) { $queue.Enqueue($childId) }
    }
  }
  return @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
}

function Add-Sample {
  $snapshot = @(Get-RelatedProcessSnapshot -Name $ProcessName)
  if ($snapshot.Count -eq 0) {
    throw "未找到目标进程或其相关进程：$ProcessName"
  }
  $workingSetBytes = [double](($snapshot | Measure-Object -Property WorkingSetSize -Sum).Sum)
  $handleCount = [int](($snapshot | Measure-Object -Property HandleCount -Sum).Sum)
  $pids = ($snapshot | Sort-Object ProcessId | ForEach-Object ProcessId) -join ";"
  $timestamp = [DateTime]::UtcNow.ToString("o")
  '{0},{1},{2},{3},"{4}"' -f $timestamp,
    [Math]::Round($workingSetBytes / 1MB, 3), $handleCount, $snapshot.Count, $pids |
    Add-Content -LiteralPath $memoryPath -Encoding utf8NoBOM
  @{
    timestampUtc = $timestamp
    processName = $ProcessName
    processCount = $snapshot.Count
    processIds = @($snapshot | Sort-Object ProcessId | ForEach-Object ProcessId)
    handleCount = $handleCount
  } | ConvertTo-Json -Compress | Add-Content -LiteralPath $handlesPath -Encoding utf8NoBOM
}

$sampleCount = 0
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    Add-Sample
    $sampleCount++
    $remainingSeconds = [Math]::Max(1, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
    Start-Sleep -Seconds ([Math]::Min($SampleIntervalSeconds, $remainingSeconds))
  }
}
finally {
  $finishedAt = [DateTime]::UtcNow
  @{ timestampUtc = $finishedAt.ToString("o"); event = "collector_finished"; sampleCount = $sampleCount } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $eventsPath -Encoding utf8NoBOM
  [ordered]@{
    schemaVersion = 1
    runId = $RunId
    processName = $ProcessName
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    durationHours = [Math]::Round(($finishedAt - $startedAt).TotalHours, 6)
    sampleIntervalSeconds = $SampleIntervalSeconds
    sampleCount = $sampleCount
    commit = $Commit
    baselineCommit = $BaselineCommit
    evidence = [ordered]@{
      processMemory = "artifacts/stability/process-memory.csv"
      lifecycleEvents = "artifacts/stability/lifecycle-events.jsonl"
      handleSnapshots = "artifacts/stability/handle-snapshots.jsonl"
    }
    note = "采集器只记录原始进程证据，不自动执行 SSH/SFTP、休眠唤醒或断网场景，也不生成通过结论。"
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
}

Write-Output "Windows 稳定性原始证据采集完成：$resolvedOutputDir（样本 $sampleCount）"
