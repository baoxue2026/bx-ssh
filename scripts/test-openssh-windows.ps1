[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$')]
    [string]$MatrixId,

    [ValidateSet("ed25519", "ecdsa-p256", "rsa-sha2")]
    [string]$HostKeyAlgorithm = "ed25519",

    [string]$Target = "",

    [switch]$IncludeSftp,

    [ValidateSet("release", "debug")]
    [string]$BuildProfile = "release",

    [switch]$SkipSftpBenchmark,

    [switch]$IncludeTenSessions,

    [switch]$IncludeDesktopE2e,

    [ValidateRange(1, 64)]
    [int]$MaxSessionsPerConnection = 10,

    [ValidateRange(1, 1073741824)]
    [UInt64]$SftpBytes = 8388608,

    [UInt64]$SftpBaselineBps = 0,

    [switch]$RequireOneGiB
)

$ErrorActionPreference = "Stop"
if ($RequireOneGiB -and (-not $IncludeSftp -or $BuildProfile -ne "release" -or $SkipSftpBenchmark -or $SftpBaselineBps -ne 0)) {
    throw "-RequireOneGiB requires -IncludeSftp, a release build, and freshly measured per-direction OpenSSH baselines"
}
if ($SkipSftpBenchmark -and $SftpBaselineBps -ne 0) {
    throw "-SkipSftpBenchmark cannot be combined with -SftpBaselineBps"
}
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bx-ssh-openssh-" + [guid]::NewGuid())
$reportDirectory = Join-Path (Get-Location) "artifacts/test-reports"
$reportPath = Join-Path $reportDirectory "openssh-$MatrixId.md"
$reportLogPath = Join-Path $reportDirectory "openssh-$MatrixId.log"
$reportJsonPath = Join-Path $reportDirectory "openssh-$MatrixId.json"
$serverLogPath = Join-Path $testRoot "sshd.stderr.log"
$testOutputPath = Join-Path $testRoot "test-output.log"
$serverVersion = "unavailable"
$targetName = $Target
$result = "FAIL"
$sftpResult = "not-run"
$sftpSummary = ""
$sftpSpeed = ""
$cargoOutput = ""
$cargoExitCode = $null
$failureMessage = $null
$baselineEvidence = $null
$desktopE2eResult = "not-run"
$startedAt = [DateTime]::UtcNow.ToString("o")
$sourceCommit = (& git rev-parse HEAD | Out-String).Trim()
$sourceDirty = -not [string]::IsNullOrWhiteSpace((& git status --porcelain | Out-String))
$savedTestEnvironment = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'BX_SSH_TEST_*' } | ForEach-Object {
    $savedTestEnvironment[$_.Name] = $_.Value
}
$testUser = "bxsshci" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$testPassword = "BxSsh-CI-9!Password"
$userCreated = $false
$testUserSid = $null
$sshdServiceName = "BxSshCompat-" + ([guid]::NewGuid().ToString("N").Substring(0, 12))
$sshdServiceCreated = $false
$cargoArguments = @("test", "--locked", "-p", "bx-ssh-core", "--test", "openssh")
if ($BuildProfile -eq "release") { $cargoArguments += "--release" }
if ($IncludeSftp) { $cargoArguments += @("--test", "sftp") }

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $ArgumentList"
    }
}

function Convert-ToSshPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Replace("\", "/")
}

function New-SftpTestFile {
    param([string]$Path, [UInt64]$Bytes)
    $block = [byte[]]::new(1MB)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew)
    try {
        $random.GetBytes($block)
        $remaining = $Bytes
        while ($remaining -gt 0) {
            $count = [int][Math]::Min($remaining, $block.Length)
            $stream.Write($block, 0, $count)
            $remaining -= $count
        }
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
        $random.Dispose()
    }
}

function Convert-TestMetrics {
    param([string]$Line)
    $metrics = [ordered]@{}
    foreach ($match in [regex]::Matches($Line, '(\w+)=([^\s]+)')) {
        $value = $match.Groups[2].Value
        if ($value -match '^\d+$') { $value = [UInt64]$value }
        elseif ($value -in @('true', 'false')) { $value = $value -eq 'true' }
        $metrics[$match.Groups[1].Value] = $value
    }
    return $metrics
}

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    # Each invocation owns its fixture; inherited flags must not change its gates.
    Get-ChildItem Env: | Where-Object { $_.Name -like 'BX_SSH_TEST_*' } | ForEach-Object {
        [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process')
    }
    # Finish compilation before creating a server or collecting timed baselines.
    $cargoBuildOutput = (& cargo.exe @cargoArguments --no-run 2>&1 | Out-String)
    $cargoExitCode = $LASTEXITCODE
    $cargoBuildOutput | Set-Content -LiteralPath $testOutputPath -Encoding utf8
    if ($cargoExitCode -ne 0) {
        throw "OpenSSH integration test compilation failed with exit code $cargoExitCode"
    }

    $openSshDirectory = Join-Path $env:WINDIR "System32/OpenSSH"
    $sshd = Join-Path $openSshDirectory "sshd.exe"
    if (-not (Test-Path -LiteralPath $sshd)) {
        Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
    }
    if (-not (Test-Path -LiteralPath $sshd)) {
        throw "Windows OpenSSH Server is unavailable after capability installation"
    }

    $ssh = Join-Path $openSshDirectory "ssh.exe"
    $sshKeygen = Join-Path $openSshDirectory "ssh-keygen.exe"
    $sftp = Join-Path $openSshDirectory "sftp.exe"
    $sftpServer = Join-Path $openSshDirectory "sftp-server.exe"
    foreach ($requiredTool in @($ssh, $sshKeygen, $sftp, $sftpServer)) {
        if (-not (Test-Path -LiteralPath $requiredTool)) {
            throw "Required OpenSSH tool is missing: $requiredTool"
        }
    }
    $serverVersion = ((& $ssh -V 2>&1) | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($targetName)) {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        $targetName = "{0} (Build {1})" -f $os.Caption, $os.BuildNumber
    }

    $securePassword = ConvertTo-SecureString $testPassword -AsPlainText -Force
    $createdUser = New-LocalUser `
        -Name $testUser `
        -Password $securePassword `
        -AccountNeverExpires `
        -PasswordNeverExpires `
        -UserMayNotChangePassword `
        -Description "Temporary BX SSH compatibility test account"
    $userCreated = $true
    $testUserSid = $createdUser.SID.Value

    $clientKey = Join-Path $testRoot "client_ed25519"
    Invoke-NativeCommand -FilePath $sshKeygen -ArgumentList @(
        "-q", "-t", "ed25519", "-N", "", "-f", $clientKey
    )

    switch ($HostKeyAlgorithm) {
        "ed25519" {
            $hostKey = Join-Path $testRoot "ssh_host_ed25519_key"
            $expectedHostKeyAlgorithm = "ssh-ed25519"
            Invoke-NativeCommand -FilePath $sshKeygen -ArgumentList @(
                "-q", "-t", "ed25519", "-N", "", "-f", $hostKey
            )
        }
        "ecdsa-p256" {
            $hostKey = Join-Path $testRoot "ssh_host_ecdsa_key"
            $expectedHostKeyAlgorithm = "ecdsa-sha2-nistp256"
            Invoke-NativeCommand -FilePath $sshKeygen -ArgumentList @(
                "-q", "-t", "ecdsa", "-b", "256", "-N", "", "-f", $hostKey
            )
        }
        "rsa-sha2" {
            $hostKey = Join-Path $testRoot "ssh_host_rsa_key"
            $expectedHostKeyAlgorithm = "ssh-rsa"
            Invoke-NativeCommand -FilePath $sshKeygen -ArgumentList @(
                "-q", "-t", "rsa", "-b", "3072", "-N", "", "-f", $hostKey
            )
        }
    }

    Invoke-NativeCommand -FilePath "icacls.exe" -ArgumentList @(
        $hostKey,
        "/inheritance:r",
        "/remove:g",
        "$env:USERDOMAIN\$env:USERNAME",
        "Users",
        "Authenticated Users",
        "/grant:r",
        "SYSTEM:(F)",
        "Administrators:(F)"
    )
    Invoke-NativeCommand -FilePath "icacls.exe" -ArgumentList @(
        $hostKey,
        "/setowner",
        "SYSTEM"
    )

    $authorizedKeys = Join-Path $testRoot "authorized_keys"
    Copy-Item -LiteralPath "$clientKey.pub" -Destination $authorizedKeys

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()

    $sshdConfig = Join-Path $testRoot "sshd_config"
    $hostKeyPath = Convert-ToSshPath $hostKey
    $authorizedKeysPath = Convert-ToSshPath $authorizedKeys
    $sftpServerPath = Convert-ToSshPath $sftpServer
    $pidPath = Convert-ToSshPath (Join-Path $testRoot "sshd.pid")
    @"
Port $port
ListenAddress 127.0.0.1
HostKey $hostKeyPath
PidFile $pidPath
AuthorizedKeysFile $authorizedKeysPath
AcceptEnv BX_SSH_TEST_ENV
MaxStartups 64
MaxSessions $MaxSessionsPerConnection
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication no
PermitEmptyPasswords no
StrictModes no
AllowUsers $testUser
Subsystem sftp $sftpServerPath
LogLevel VERBOSE
"@ | Set-Content -LiteralPath $sshdConfig -Encoding utf8

    Invoke-NativeCommand -FilePath $sshd -ArgumentList @("-t", "-f", $sshdConfig)
    $serviceBinaryPath = '"{0}" -D -e -E "{1}" -f "{2}"' -f $sshd, $serverLogPath, $sshdConfig
    # New-Service preserves the complete binary path (including arguments) and
    # runs under LocalSystem by default, which is required for sshd to create
    # the unprivileged child process on Windows.
    New-Service `
        -Name $sshdServiceName `
        -BinaryPathName $serviceBinaryPath `
        -DisplayName "BX SSH OpenSSH compatibility ($MatrixId)" `
        -StartupType Manual | Out-Null
    $sshdServiceCreated = $true
    Start-Service -Name $sshdServiceName

    $ready = $false
    foreach ($attempt in 1..30) {
        $service = Get-Service -Name $sshdServiceName -ErrorAction SilentlyContinue
        if ($null -eq $service -or $service.Status -eq "Stopped") {
            throw "Windows OpenSSH Server service exited before accepting connections"
        }
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connection = $client.ConnectAsync("127.0.0.1", $port)
            if ($connection.Wait(500) -and $client.Connected) {
                $ready = $true
                break
            }
        }
        catch {
            # The server may still be starting.
        }
        finally {
            $client.Dispose()
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw "Windows OpenSSH Server did not become ready"
    }

    $env:BX_SSH_TEST_HOST = "127.0.0.1"
    $env:BX_SSH_TEST_PORT = $port.ToString()
    $env:BX_SSH_TEST_USERNAME = $testUser
    $env:BX_SSH_TEST_PASSWORD = $testPassword
    $env:BX_SSH_TEST_PRIVATE_KEY = $clientKey
    $env:BX_SSH_TEST_HOST_KEY_ALGORITHM = $HostKeyAlgorithm
    $env:BX_SSH_TEST_EXPECTED_HOST_KEY_ALGORITHM = $expectedHostKeyAlgorithm
    $fingerprintOutput = (& $sshKeygen -l -E sha256 -f "$hostKey.pub" | Out-String).Trim()
    $env:BX_SSH_TEST_EXPECTED_FINGERPRINT = ($fingerprintOutput -split '\s+')[1]
    $env:BX_SSH_TEST_EXPECTED_EXIT_STATUS = "0"
    $env:BX_SSH_TEST_WINDOWS_SERVER = "1"
    $env:BX_SSH_TEST_AUTH_METHODS = "password,public-key"
    $env:BX_SSH_TEST_SHELL_KIND = "windows-cmd"
    if ($IncludeSftp) {
        if ($RequireOneGiB) {
            $SftpBytes = 1GB
        }
        $env:BX_SSH_TEST_SFTP_BYTES = $SftpBytes.ToString()
        if (-not $SkipSftpBenchmark -and $SftpBaselineBps -eq 0) {
            $baselinePath = Join-Path $testRoot "openssh-sftp-baseline.bin"
            New-SftpTestFile -Path $baselinePath -Bytes $SftpBytes
            $env:BX_SSH_TEST_SFTP_SOURCE_FILE = $baselinePath
            $baselineSha256 = (Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $remoteBaselineName = ".bx-ssh-sftp-baseline-$([guid]::NewGuid().ToString('N')).bin"
            $uploadBatch = Join-Path $testRoot "sftp-upload.txt"
            $downloadBatch = Join-Path $testRoot "sftp-download.txt"
            @(
                "put `"$($baselinePath.Replace('\', '/'))`" $remoteBaselineName"
            ) | Set-Content -LiteralPath $uploadBatch -Encoding utf8
            @(
                "get $remoteBaselineName `"$($baselinePath.Replace('\', '/')).download`""
            ) | Set-Content -LiteralPath $downloadBatch -Encoding utf8
            $sftpArguments = @(
                "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=NUL", "-i", $clientKey, "-P", $port.ToString(),
                "-b", $uploadBatch, "$testUser@127.0.0.1"
            )
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-NativeCommand -FilePath $sftp -ArgumentList $sftpArguments
            $watch.Stop()
            $uploadBaselineMs = $watch.Elapsed.TotalMilliseconds
            $uploadBaselineBps = [UInt64]([Math]::Max(1, [Math]::Round($SftpBytes / $watch.Elapsed.TotalSeconds)))
            $sftpArguments = @(
                "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=NUL", "-i", $clientKey, "-P", $port.ToString(),
                "-b", $downloadBatch, "$testUser@127.0.0.1"
            )
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-NativeCommand -FilePath $sftp -ArgumentList $sftpArguments
            $watch.Stop()
            $downloadBaselineMs = $watch.Elapsed.TotalMilliseconds
            $downloadBaselineBps = [UInt64]([Math]::Max(1, [Math]::Round($SftpBytes / $watch.Elapsed.TotalSeconds)))
            $downloadedBaseline = Get-Item -LiteralPath "$baselinePath.download"
            if ($downloadedBaseline.Length -ne $SftpBytes -or (Get-FileHash -LiteralPath $downloadedBaseline.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $baselineSha256) {
                throw "The OpenSSH SFTP baseline failed file size or SHA-256 verification"
            }
            $env:BX_SSH_TEST_SFTP_BASELINE_UPLOAD_BPS = $uploadBaselineBps.ToString()
            $env:BX_SSH_TEST_SFTP_BASELINE_DOWNLOAD_BPS = $downloadBaselineBps.ToString()
            $baselineEvidence = [ordered]@{
                kind = 'measured'; bytes = $SftpBytes; sha256 = $baselineSha256
                upload_bps = $uploadBaselineBps; download_bps = $downloadBaselineBps
                upload_ms = $uploadBaselineMs; download_ms = $downloadBaselineMs
                timing = 'OpenSSH process startup, authentication and transfer; excludes separate SHA-256 verification'
            }
            $cleanupBatch = Join-Path $testRoot "sftp-cleanup.txt"
            @("rm $remoteBaselineName") | Set-Content -LiteralPath $cleanupBatch -Encoding utf8
            Invoke-NativeCommand -FilePath $sftp -ArgumentList @(
                '-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL',
                '-i', $clientKey, '-P', $port.ToString(), '-b', $cleanupBatch, "$testUser@127.0.0.1"
            )
        }
        elseif ($SftpBaselineBps -ne 0) {
            $env:BX_SSH_TEST_SFTP_BASELINE_BPS = $SftpBaselineBps.ToString()
            # Keep the direction-specific gate deterministic when a caller
            # supplies a single legacy baseline value.
            $env:BX_SSH_TEST_SFTP_BASELINE_UPLOAD_BPS = $SftpBaselineBps.ToString()
            $env:BX_SSH_TEST_SFTP_BASELINE_DOWNLOAD_BPS = $SftpBaselineBps.ToString()
            $baselineEvidence = [ordered]@{ kind = 'supplied-legacy'; upload_bps = $SftpBaselineBps; download_bps = $SftpBaselineBps }
        }
        if ($RequireOneGiB) {
            $env:BX_SSH_TEST_SFTP_REQUIRE_ONE_GIB = "1"
            $env:BX_SSH_TEST_SFTP_PHASE_TIMEOUT_SECS = "900"
        }
    }
    if ($IncludeTenSessions) {
        $env:BX_SSH_TEST_TEN_SESSIONS = "1"
    }
    $cargoArguments += @("--", "--ignored", "--nocapture")
    & cargo.exe @cargoArguments 2>&1 | Tee-Object -FilePath $testOutputPath -Append
    $cargoExitCode = $LASTEXITCODE
    $cargoOutput = Get-Content -LiteralPath $testOutputPath -Raw
    $sftpResult = if ($IncludeSftp) { "PASS" } else { "not-run" }
    $sftpSummary = [regex]::Match($cargoOutput, "BX_SFTP_RESULT[^\r\n]*").Value
    $sftpSpeed = [regex]::Match($cargoOutput, "BX_SFTP_SPEED[^\r\n]*").Value
    if ($cargoExitCode -ne 0) {
        if ($IncludeSftp) { $sftpResult = "FAIL" }
        if ($IncludeSftp -and $cargoOutput -match "SFTP (upload|download) speed .* below") {
            $sftpResult = "FAIL_SPEED"
        }
        throw "OpenSSH integration tests failed with exit code $cargoExitCode"
    }
    if ($IncludeDesktopE2e) {
        $desktopE2eResult = "FAIL"
        $env:BX_SSH_TEST_DESKTOP_E2E = "1"
        & pnpm --filter @bx-ssh/desktop test:e2e --spec ./tests/e2e/ssh-workflows.spec.ts
        $desktopE2eExitCode = $LASTEXITCODE
        if ($desktopE2eExitCode -ne 0) {
            throw "Real SSH desktop E2E tests failed with exit code $desktopE2eExitCode"
        }
        $desktopE2eResult = "PASS"
    }
    $result = "PASS"
}
catch {
    $failureMessage = $_.Exception.Message
    throw
}
finally {
    Get-ChildItem Env: | Where-Object { $_.Name -like 'BX_SSH_TEST_*' } | ForEach-Object {
        [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process')
    }
    foreach ($name in $savedTestEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedTestEnvironment[$name], 'Process')
    }
    if ($sshdServiceCreated) {
        Stop-Service -Name $sshdServiceName -Force -ErrorAction SilentlyContinue
        for ($attempt = 1; $attempt -le 20; $attempt++) {
            $service = Get-Service -Name $sshdServiceName -ErrorAction SilentlyContinue
            if ($null -eq $service -or $service.Status -eq "Stopped") {
                break
            }
            Start-Sleep -Milliseconds 250
        }
        & sc.exe delete $sshdServiceName | Out-Null
    }
    if (Test-Path -LiteralPath $serverLogPath) {
        $copied = $false
        for ($attempt = 1; $attempt -le 20; $attempt++) {
            try {
                Copy-Item -LiteralPath $serverLogPath -Destination $reportLogPath -Force -ErrorAction Stop
                $copied = $true
                break
            }
            catch {
                Start-Sleep -Milliseconds 250
            }
        }
        if (-not $copied) {
            "Unable to copy sshd log before cleanup completed." | Set-Content -LiteralPath $reportLogPath -Encoding utf8
        }
    }
    else {
        New-Item -ItemType File -Path $reportLogPath -Force | Out-Null
    }
    if (Test-Path -LiteralPath $testOutputPath) {
        Add-Content -LiteralPath $reportLogPath -Value "`r`n--- cargo test output ---`r`n"
        Get-Content -LiteralPath $testOutputPath | Add-Content -LiteralPath $reportLogPath
    }
    if ($userCreated) {
        Remove-LocalUser -Name $testUser -ErrorAction SilentlyContinue
        # Only remove the profile associated with the SID created by this run.
        $testProfile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$testUserSid'" -ErrorAction SilentlyContinue
        if ($null -ne $testProfile -and -not $testProfile.Loaded) {
            $profileDirectorySetting = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory
            $profilesDirectory = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($profileDirectorySetting))
            $expectedProfilePath = [System.IO.Path]::GetFullPath((Join-Path $profilesDirectory $testUser))
            $actualProfilePath = [System.IO.Path]::GetFullPath($testProfile.LocalPath)
            if ($actualProfilePath.Equals($expectedProfilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
                $testProfile | Remove-CimInstance -ErrorAction SilentlyContinue
            }
        }
    }

    @"
# BX SSH OpenSSH integration test

- Matrix: $MatrixId
- Target: $targetName
- Host key algorithm: $HostKeyAlgorithm
- Authentication methods: password, public-key
- Server: $serverVersion
- Build profile: $BuildProfile
- Source commit: $sourceCommit (dirty: $sourceDirty)
- Result: $result
- SFTP result: $sftpResult
- SFTP summary: $sftpSummary
- SFTP speed comparison: $sftpSpeed
- Real SSH desktop E2E: $desktopE2eResult
- Timing: upload_ms/download_ms cover transfer; upload_total_ms/download_total_ms also include verification and publication.
- Failure: $failureMessage
"@ | Set-Content -LiteralPath $reportPath -Encoding utf8

    [ordered]@{
        schemaVersion = 1; matrixId = $MatrixId; startedAt = $startedAt; generatedAt = [DateTime]::UtcNow.ToString('o')
        sourceCommit = $sourceCommit; sourceDirty = $sourceDirty; target = $targetName
        serverVersion = $serverVersion; hostKeyAlgorithm = $HostKeyAlgorithm; buildProfile = $BuildProfile
        maxSessionsPerConnection = $MaxSessionsPerConnection
        result = $result; cargoExitCode = $cargoExitCode; failure = $failureMessage
        desktopE2eResult = $desktopE2eResult
        tenSessionsRequested = $IncludeTenSessions.IsPresent
        sessions = (Convert-TestMetrics ([regex]::Match($cargoOutput, 'BX_SESSION_RESULT[^\r\n]*').Value))
        sftp = [ordered]@{
            result = $sftpResult; requiredOneGiB = $RequireOneGiB.IsPresent
            baseline = $baselineEvidence; transfer = (Convert-TestMetrics $sftpSummary); comparison = (Convert-TestMetrics $sftpSpeed)
            timings = (Convert-TestMetrics ([regex]::Match($cargoOutput, 'BX_SFTP_TIMING[^\r\n]*').Value))
            phases = @([regex]::Matches($cargoOutput, 'BX_SFTP_PHASE[^\r\n]*elapsed_ms=\d+') | ForEach-Object { Convert-TestMetrics $_.Value })
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportJsonPath -Encoding utf8

    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot)
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ([System.IO.Path]::GetDirectoryName($resolvedRoot).Equals($temporaryRoot.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase) -and [System.IO.Path]::GetFileName($resolvedRoot).StartsWith('bx-ssh-openssh-')) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
