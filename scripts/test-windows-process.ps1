$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-process.ps1")
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot ("bx-ssh-process-" + [guid]::NewGuid() + " 测试")))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

try {
  $argumentScript = Join-Path $testRoot "arguments.ps1"
  @'
param([string]$OutputPath, [string]$Value)
[System.IO.File]::WriteAllText($OutputPath, $Value)
exit 7
'@ | Set-Content -LiteralPath $argumentScript -Encoding utf8NoBOM
  $outputPath = Join-Path $testRoot "argument result.txt"
  $expected = '带 空格 "quoted" C:\trailing\'
  $exitCode = Invoke-ProcessChecked -FilePath $pwsh -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-File", $argumentScript, $outputPath, $expected
  ) -AllowedExitCodes @(7)
  if ($exitCode -ne 7 -or [System.IO.File]::ReadAllText($outputPath) -cne $expected) {
    throw "路径、引号、Unicode 或尾部反斜杠参数未被完整传递"
  }

  $rejected = $false
  try {
    Invoke-ProcessChecked -FilePath $pwsh -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-Command", "exit 9"
    ) | Out-Null
  }
  catch { $rejected = $_.Exception.Message -match '退出码 9' }
  if (-not $rejected) { throw "未拒绝非预期退出码" }

  $timeoutScript = Join-Path $testRoot "timeout.ps1"
  @'
param([string]$PidPath)
$child = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
  "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"
) -WindowStyle Hidden -PassThru
@($PID, $child.Id) | ConvertTo-Json | Set-Content -LiteralPath $PidPath
Start-Sleep -Seconds 60
'@ | Set-Content -LiteralPath $timeoutScript -Encoding utf8NoBOM
  $pidPath = Join-Path $testRoot "processes.json"
  $started = [System.Diagnostics.Stopwatch]::StartNew()
  $timedOut = $false
  try {
    Invoke-ProcessChecked -FilePath $pwsh -ArgumentList @(
      "-NoProfile", "-NonInteractive", "-File", $timeoutScript, $pidPath
    ) -TimeoutSeconds 5 | Out-Null
  }
  catch { $timedOut = $_.Exception.Message -match '命令超时' }
  if (-not $timedOut -or $started.Elapsed.TotalSeconds -gt 15) {
    throw "超时未在规定时间内生效"
  }
  $processIds = @(Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json)
  if ($processIds.Count -ne 2) { throw "未创建父子进程用于超时测试" }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $remaining = @(Get-Process -Id $processIds -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remaining.Count -gt 0) { throw "超时后仍存在测试子进程" }

  Write-Output "Windows 进程回归通过：参数边界、退出码、超时及子进程清理"
}
finally {
  $cleanupPath = [System.IO.Path]::GetFullPath($testRoot)
  if ((Split-Path -Parent $cleanupPath).TrimEnd('\') -ne $temporaryRoot.TrimEnd('\') -or
      (Split-Path -Leaf $cleanupPath) -notmatch '^bx-ssh-process-[0-9a-f-]{36} 测试$') {
    throw "拒绝清理测试目录之外的路径：$cleanupPath"
  }
  Remove-Item -LiteralPath $cleanupPath -Recurse -Force
}
