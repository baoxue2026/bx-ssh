[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MatrixId,

    [ValidateSet("ed25519", "ecdsa-p256", "rsa-sha2")]
    [string]$HostKeyAlgorithm = "ed25519",

    [string]$Target = ""
)

$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("bx-ssh-openssh-" + [guid]::NewGuid())
$reportDirectory = Join-Path (Get-Location) "artifacts/test-reports"
$reportPath = Join-Path $reportDirectory "openssh-$MatrixId.md"
$reportLogPath = Join-Path $reportDirectory "openssh-$MatrixId.log"
$serverLogPath = Join-Path $testRoot "sshd.stderr.log"
$serverVersion = "unavailable"
$targetName = $Target
$result = "FAIL"
$testUser = "bxsshci" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$testPassword = "BxSsh-CI-9!Password"
$userCreated = $false
$sshdServiceName = "BxSshCompat-" + ([guid]::NewGuid().ToString("N").Substring(0, 12))
$sshdServiceCreated = $false

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

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null

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
    $sftpServer = Join-Path $openSshDirectory "sftp-server.exe"
    foreach ($requiredTool in @($ssh, $sshKeygen, $sftpServer)) {
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
    New-LocalUser `
        -Name $testUser `
        -Password $securePassword `
        -AccountNeverExpires `
        -PasswordNeverExpires `
        -UserMayNotChangePassword `
        -Description "Temporary BX SSH compatibility test account" | Out-Null
    $userCreated = $true

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
    $env:BX_SSH_TEST_EXPECTED_EXIT_STATUS = "0"
    $env:BX_SSH_TEST_AUTH_METHODS = "password,public-key"
    $env:BX_SSH_TEST_SHELL_KIND = "windows-cmd"
    Invoke-NativeCommand -FilePath "cargo.exe" -ArgumentList @(
        "test",
        "-p",
        "bx-ssh-core",
        "--test",
        "openssh",
        "--",
        "--ignored",
        "--nocapture"
    )
    $result = "PASS"
}
finally {
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
    if ($userCreated) {
        Remove-LocalUser -Name $testUser -ErrorAction SilentlyContinue
    }

    @"
# BX SSH OpenSSH integration test

- Matrix: $MatrixId
- Target: $targetName
- Host key algorithm: $HostKeyAlgorithm
- Authentication methods: password, public-key
- Server: $serverVersion
- Result: $result
"@ | Set-Content -LiteralPath $reportPath -Encoding utf8

    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot)
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedRoot.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
