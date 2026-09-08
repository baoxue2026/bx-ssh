[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BundleRoot,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_CERTIFICATE_BASE64) -or
    [string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_CERTIFICATE_PASSWORD)) {
  throw "受保护发布环境缺少 Windows Authenticode 证书或密码"
}

$resolvedBundleRoot = [System.IO.Path]::GetFullPath($BundleRoot)
if (-not (Test-Path -LiteralPath $resolvedBundleRoot -PathType Container)) {
  throw "安装包目录不存在: $resolvedBundleRoot"
}

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($null -eq $signtool) {
  throw "Windows runner 未提供 signtool.exe"
}

$certificatePath = Join-Path $env:RUNNER_TEMP ("bx-ssh-codesign-" + [Guid]::NewGuid().ToString("N") + ".pfx")
$certificateBytes = [Convert]::FromBase64String($env:WINDOWS_CODESIGN_CERTIFICATE_BASE64)
[System.IO.File]::WriteAllBytes($certificatePath, $certificateBytes)

try {
  $installers = Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File |
    Where-Object { $_.Extension.ToLowerInvariant() -in @(".exe", ".msi") }
  if ($installers.Count -eq 0) {
    throw "未找到 Windows MSI/NSIS 安装包"
  }

  $results = @()
  foreach ($installer in $installers) {
    & $signtool.Source sign /quiet /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" /f $certificatePath /p $env:WINDOWS_CODESIGN_CERTIFICATE_PASSWORD $installer.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Authenticode 签名失败: $($installer.Name)"
    }
    & $signtool.Source verify /pa /all $installer.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Authenticode 签名验证失败: $($installer.Name)"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.Status -ne "Valid") {
      throw "Authenticode API 验证失败: $($installer.Name) ($($signature.Status))"
    }
    $results += [ordered]@{
      path = $installer.FullName.Substring($resolvedBundleRoot.Length).TrimStart([char[]]@("\", "/")).Replace("\", "/")
      sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      signerSubject = $signature.SignerCertificate.Subject
      signerThumbprint = $signature.SignerCertificate.Thumbprint
      timestamped = $null -ne $signature.TimeStamperCertificate
      status = "valid"
    }
    Write-Output "已签名并验证: $($installer.Name)"
  }

  $resolvedReportPath = [System.IO.Path]::GetFullPath($ReportPath)
  $reportDirectory = Split-Path -Parent $resolvedReportPath
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    passed = $true
    artifacts = $results
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedReportPath -Encoding utf8NoBOM
}
finally {
  if (Test-Path -LiteralPath $certificatePath) {
    Remove-Item -LiteralPath $certificatePath -Force
  }
  if ($null -ne $certificateBytes) {
    [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
  }
  Remove-Variable certificateBytes -ErrorAction SilentlyContinue
}
