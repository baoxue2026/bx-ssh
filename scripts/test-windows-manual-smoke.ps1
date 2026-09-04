[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ApplicationPath,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath
)

$ErrorActionPreference = "Stop"
$resolvedApplicationPath = [System.IO.Path]::GetFullPath($ApplicationPath)
$resolvedReportPath = [System.IO.Path]::GetFullPath($ReportPath)
$reportDirectory = Split-Path -Parent $resolvedReportPath
$first = $null
$second = $null
$startedAt = [DateTime]::UtcNow
$checks = [ordered]@{
  applicationExists = Test-Path -LiteralPath $resolvedApplicationPath -PathType Leaf
  startup = "not-run"
  responsive = "not-run"
  singleInstance = "not-run"
}

try {
  if (-not $checks.applicationExists) {
    throw "应用程序不存在：$resolvedApplicationPath"
  }

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $first = Start-Process -FilePath $resolvedApplicationPath -PassThru -WindowStyle Hidden
  $ready = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    $first.Refresh()
    if ($first.HasExited) { break }
    if ($first.MainWindowHandle -ne 0) {
      $ready = $true
      break
    }
  }
  $watch.Stop()
  if (-not $ready) {
    throw "应用程序未在 30 秒内创建主窗口"
  }
  $checks.startup = [ordered]@{
    result = "passed"
    elapsedMs = [int][Math]::Min([int]::MaxValue, $watch.ElapsedMilliseconds)
  }
  $checks.responsive = if ($first.Responding) { "passed" } else { "failed" }
  if ($checks.responsive -eq "failed") {
    throw "主窗口无响应"
  }

  $second = Start-Process -FilePath $resolvedApplicationPath -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $second.Refresh()
  $first.Refresh()
  $checks.singleInstance = [ordered]@{
    result = if ($second.HasExited -or $second.MainWindowHandle -eq 0) { "passed" } else { "failed" }
    secondProcessExited = $second.HasExited
    secondWindowHandle = $second.MainWindowHandle.ToInt64()
    firstProcessId = $first.Id
  }
  if ($checks.singleInstance.result -eq "failed") {
    throw "第二次启动创建了独立窗口，单实例约束未生效"
  }

  [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    application = $resolvedApplicationPath
    environment = [ordered]@{
      platform = "Windows"
      os = (Get-CimInstance -ClassName Win32_OperatingSystem).Caption
      build = (Get-CimInstance -ClassName Win32_OperatingSystem).BuildNumber
      architecture = $env:PROCESSOR_ARCHITECTURE
    }
    checks = $checks
    manualChecksRequired = @(
      "使用已签名安装包完成首次安装、覆盖升级和卸载",
      "连接真实 SSH 服务器并验证终端、SFTP、指纹和凭据流程",
      "在 Windows 11 24H2 验证高 DPI、输入法、系统代理和托盘恢复"
    )
    result = "pass"
  } | ConvertTo-Json -Depth 8 | ForEach-Object {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $_ | Set-Content -LiteralPath $resolvedReportPath -Encoding utf8NoBOM
  }
  Write-Output "Windows 桌面人工验收冒烟通过：$resolvedReportPath"
}
finally {
  if ($null -ne $second -and -not $second.HasExited) {
    Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $first -and -not $first.HasExited) {
    Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue
  }
}
