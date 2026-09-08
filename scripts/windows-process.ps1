# PowerShell 7 process runner: preserve argument boundaries and bound the wait.
function Invoke-ProcessChecked {
  [CmdletBinding(DefaultParameterSetName = "Arguments")]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(ParameterSetName = "Arguments")][string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true, ParameterSetName = "Raw")][string]$RawArguments,
    [int[]]$AllowedExitCodes = @(0),
    [string]$WorkingDirectory = "",
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 120
  )

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  if ($PSCmdlet.ParameterSetName -eq "Raw") {
    # NSIS requires its final /D= destination to be unquoted, even with spaces.
    $start.Arguments = $RawArguments
  }
  else {
    foreach ($argument in $ArgumentList) { $start.ArgumentList.Add($argument) }
  }
  if ($WorkingDirectory) { $start.WorkingDirectory = $WorkingDirectory }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    Write-Host "运行 $(Split-Path -Leaf $FilePath)（超时 ${TimeoutSeconds} 秒）"
    $null = $process.Start()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill($true)
        $null = $process.WaitForExit(5000)
      }
      catch { Write-Warning "无法结束超时进程：$($process.Id)" }
      throw "命令超时（${TimeoutSeconds} 秒）：$FilePath"
    }
    $exitCode = $process.ExitCode
    if ($exitCode -notin $AllowedExitCodes) {
      throw "命令失败（退出码 ${exitCode}）：$FilePath"
    }
    return $exitCode
  }
  finally { $process.Dispose() }
}
