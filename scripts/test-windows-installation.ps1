[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BundleRoot,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath,

  [switch]$RequireAuthenticodeSignature,

  [string]$PreviousInstaller
)

$ErrorActionPreference = "Stop"
$resolvedBundleRoot = [System.IO.Path]::GetFullPath($BundleRoot)
$resolvedReportPath = [System.IO.Path]::GetFullPath($ReportPath)
$reportDirectory = Split-Path -Parent $resolvedReportPath
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bx-ssh-install-" + [guid]::NewGuid())
$results = @()
$upgrade = [ordered]@{
  requested = -not [string]::IsNullOrWhiteSpace($PreviousInstaller)
  result = "not-run"
  reason = "未提供上一版本安装包"
}

function Invoke-ProcessChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [int[]]$AllowedExitCodes = @(0),
    [string]$WorkingDirectory = "",
    [int]$TimeoutSeconds = 120
  )

  $start = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    Wait = $true
    PassThru = $true
    WindowStyle = "Hidden"
  }
  if ($WorkingDirectory) { $start.WorkingDirectory = $WorkingDirectory }
  $process = Start-Process @start
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch { }
    throw "命令超时（${TimeoutSeconds} 秒）：$FilePath $($ArgumentList -join ' ')"
  }
  if ($process.ExitCode -notin $AllowedExitCodes) {
    throw "命令失败（退出码 $($process.ExitCode)）：$FilePath $($ArgumentList -join ' ')"
  }
  return $process.ExitCode
}

function Assert-Authenticode {
  param([Parameter(Mandatory = $true)][System.IO.FileInfo]$Installer)
  $signature = Get-AuthenticodeSignature -LiteralPath $Installer.FullName
  if ($signature.Status -ne "Valid") {
    throw "安装包 Authenticode 签名无效：$($Installer.Name)（$($signature.Status)）"
  }
  return [ordered]@{
    status = "valid"
    signerSubject = $signature.SignerCertificate.Subject
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    timestamped = $null -ne $signature.TimeStamperCertificate
  }
}

function Find-UninstallEntries {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry.DisplayName -like "BX SSH*") {
        [pscustomobject]@{
          Key = $_.PSPath
          DisplayName = $entry.DisplayName
          UninstallString = $entry.UninstallString
          QuietUninstallString = $entry.QuietUninstallString
          InstallLocation = $entry.InstallLocation
        }
      }
    }
  }
}

function Find-NsisUninstaller {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)
  return Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "uninstall" } |
    Select-Object -First 1
}

function Install-Nsis {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$Installer,
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  Invoke-ProcessChecked -FilePath $Installer.FullName -ArgumentList @("/S", "/D=$InstallRoot") | Out-Null
  Start-Sleep -Seconds 2
  $executables = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "*.exe" -ErrorAction SilentlyContinue)
  if ($executables.Count -eq 0) {
    throw "NSIS 安装后未发现可执行文件：$($Installer.Name)"
  }
  $uninstaller = Find-NsisUninstaller -InstallRoot $InstallRoot
  if ($null -eq $uninstaller) {
    throw "NSIS 安装后未发现卸载程序：$($Installer.Name)"
  }
  return $uninstaller
}

function Invoke-InstallerLifecycle {
  param([Parameter(Mandatory = $true)][System.IO.FileInfo]$Installer)

  $extension = $Installer.Extension.ToLowerInvariant()
  $record = [ordered]@{
    installer = $Installer.Name
    type = if ($extension -eq ".msi") { "msi" } else { "nsis" }
    sha256 = (Get-FileHash -LiteralPath $Installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    signature = $null
    install = "not-run"
    uninstall = "not-run"
    dataPreserved = $null
  }
  if ($RequireAuthenticodeSignature) {
    $record.signature = Assert-Authenticode $Installer
  }

  if ($extension -eq ".exe") {
    $installRoot = Join-Path $runRoot ("nsis-" + [guid]::NewGuid())
    $uninstaller = Install-Nsis -Installer $Installer -InstallRoot $installRoot
    $record.install = "passed"
    Invoke-ProcessChecked -FilePath $uninstaller.FullName -ArgumentList @("/S") | Out-Null
    Start-Sleep -Seconds 2
    if (Test-Path -LiteralPath $installRoot) {
      $remaining = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -ErrorAction SilentlyContinue)
      if ($remaining.Count -gt 0) {
        throw "NSIS 卸载后仍有安装文件：$($Installer.Name)"
      }
    }
    $record.uninstall = "passed"
    $record.dataPreserved = $null
  }
  else {
    $logPath = Join-Path $runRoot ($Installer.BaseName + ".msi.log")
    Invoke-ProcessChecked -FilePath "msiexec.exe" -ArgumentList @(
      "/i", $Installer.FullName, "/qn", "/norestart", "/l*v", $logPath
    ) -AllowedExitCodes @(0, 3010) | Out-Null
    Start-Sleep -Seconds 2
    $after = @(Find-UninstallEntries)
    $entry = $after | Where-Object { $_.DisplayName -like "BX SSH*" } | Select-Object -First 1
    if ($null -eq $entry) {
      throw "MSI 安装后未发现 BX SSH 卸载注册表项：$($Installer.Name)"
    }
    $record.install = "passed"
    $productCode = [regex]::Match($entry.UninstallString + " " + $entry.QuietUninstallString, "\{[0-9A-Fa-f-]{36}\}").Value
    if ([string]::IsNullOrWhiteSpace($productCode)) {
      throw "MSI 卸载注册表项缺少 ProductCode：$($Installer.Name)"
    }
    Invoke-ProcessChecked -FilePath "msiexec.exe" -ArgumentList @(
      "/x", $productCode, "/qn", "/norestart", "/l*v", (Join-Path $runRoot ($Installer.BaseName + ".uninstall.log"))
    ) -AllowedExitCodes @(0, 3010) | Out-Null
    Start-Sleep -Seconds 2
    if (@(Find-UninstallEntries | Where-Object { $_.DisplayName -like "BX SSH*" }).Count -gt 0) {
      throw "MSI 卸载后仍存在 BX SSH 注册表项：$($Installer.Name)"
    }
    $record.uninstall = "passed"
    $record.dataPreserved = $null
  }
  return $record
}

try {
  if (-not (Test-Path -LiteralPath $resolvedBundleRoot -PathType Container)) {
    throw "安装包目录不存在：$resolvedBundleRoot"
  }
  New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
  $installers = @(Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File |
    Where-Object { $_.Extension.ToLowerInvariant() -in @(".exe", ".msi") })
  if ($installers.Count -eq 0) { throw "未找到 Windows MSI/NSIS 安装包" }
  foreach ($installer in $installers) {
    $results += Invoke-InstallerLifecycle $installer
  }

  if ($upgrade.requested) {
    $previous = Get-Item -LiteralPath ([System.IO.Path]::GetFullPath($PreviousInstaller)) -ErrorAction Stop
    if ($previous.Extension.ToLowerInvariant() -ne ".exe") {
      $upgrade.result = "not-run"
      $upgrade.reason = "上一版本升级自动化目前仅支持 NSIS 安装包"
    }
    else {
      $upgradeRoot = Join-Path $runRoot ("upgrade-" + [guid]::NewGuid())
      $previousUninstaller = Install-Nsis -Installer $previous -InstallRoot $upgradeRoot
      $currentInstaller = $installers | Where-Object { $_.Extension.ToLowerInvariant() -eq ".exe" } | Select-Object -First 1
      if ($null -eq $currentInstaller) { throw "升级验证需要当前版本 NSIS 安装包" }
      $currentUninstaller = Install-Nsis -Installer $currentInstaller -InstallRoot $upgradeRoot
      if (@(Get-ChildItem -LiteralPath $upgradeRoot -Recurse -File -Filter "*.exe" -ErrorAction SilentlyContinue).Count -eq 0) {
        throw "NSIS 覆盖升级后未发现可执行文件"
      }
      Invoke-ProcessChecked -FilePath $currentUninstaller.FullName -ArgumentList @("/S") | Out-Null
      Start-Sleep -Seconds 2
      $upgrade.result = "passed"
      $upgrade.reason = "上一版本到当前版本的 NSIS 覆盖升级、最终卸载均通过"
    }
  }

  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    passed = $true
    authenticodeRequired = [bool]$RequireAuthenticodeSignature
    installers = $results
    upgrade = $upgrade
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding utf8NoBOM
  Write-Output "Windows 安装、卸载和签名验收通过：$resolvedReportPath"
}
catch {
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    passed = $false
    authenticodeRequired = [bool]$RequireAuthenticodeSignature
    installers = $results
    upgrade = $upgrade
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedReportPath -Encoding utf8NoBOM
  throw
}
finally {
  if (Test-Path -LiteralPath $runRoot) {
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
