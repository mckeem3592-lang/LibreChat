param(
    [ValidateRange(10, 1800)]
    [int]$WaitSeconds = 300
)

# Prerequisites: the Mac has already initiated
# ssh -R 127.0.0.1:2222:127.0.0.1:22 to the relay; both host keys are pinned
# in known_hosts; this script's public key is authorized on the relay and Mac.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Environment([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name must be set in this process." }
    return $value
}

function Assert-Success([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw "$Action failed with exit code $LASTEXITCODE." }
}

function Test-LocalPort([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($result)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

$relayHost = Require-Environment 'MISSION_AI_RELAY_HOST'
$relayUser = Require-Environment 'MISSION_AI_RELAY_USER'
$macUser = Require-Environment 'MISSION_AI_MAC_USER'
$publicUrl = Require-Environment 'LOCAL_MCP_PUBLIC_URL'
$token = Require-Environment 'LOCAL_MCP_TOKEN'
$ownerId = Require-Environment 'LOCAL_MCP_OWNER_USER_ID'
$origins = Require-Environment 'LOCAL_MCP_ALLOWED_ORIGINS'
if ($relayHost -notmatch '^[A-Za-z0-9.-]+$' -or
    $relayUser -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$' -or
    $macUser -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$') {
    throw 'Relay host or account name has invalid characters.'
}
if ($ownerId -notmatch '^[A-Fa-f0-9]{24}$' -or $token.Length -lt 40 -or
    $token -notmatch '^[\x21-\x7e]+$') {
    throw 'The LibreChat owner ID or bearer token is invalid.'
}
$uri = $null
if (-not [Uri]::TryCreate($publicUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -ne 'https' -or $uri.AbsolutePath.TrimEnd('/') -ne '/mcp' -or
    $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
    throw 'LOCAL_MCP_PUBLIC_URL must be an HTTPS URL ending in /mcp.'
}

$sshDirectory = Join-Path $env:USERPROFILE '.ssh'
$privateKey = Join-Path $sshDirectory 'mission_ai_mac_ed25519'
$publicKey = "$privateKey.pub"
$knownHosts = Join-Path $sshDirectory 'known_hosts'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
foreach ($binary in @($ssh, $scp, $keygen)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
        throw "Windows OpenSSH is missing: $binary"
    }
}
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
if (-not (Test-Path -LiteralPath $privateKey -PathType Leaf)) {
    if (Test-Path -LiteralPath $publicKey) {
        throw 'The public key exists without its private key; refusing to replace it.'
    }
    # An empty passphrase permits unattended operation; ACLs restrict the key to this user.
    & $keygen -q -t ed25519 -a 100 -f $privateKey -N ''
    Assert-Success 'SSH key generation'
    $userGrant = '{0}\{1}:R' -f $env:USERDOMAIN, $env:USERNAME
    & icacls.exe $privateKey /inheritance:r /grant:r $userGrant | Out-Null
    Assert-Success 'Private-key ACL restriction'
}
if (-not (Test-Path -LiteralPath $publicKey -PathType Leaf)) {
    throw 'The isolated SSH keypair is incomplete.'
}
if (-not (Test-Path -LiteralPath $knownHosts -PathType Leaf)) {
    throw 'Pinned relay and Mac host keys are required in known_hosts.'
}
& $keygen -F $relayHost -f $knownHosts *> $null
Assert-Success 'Relay host-key lookup'
& $keygen -F '[127.0.0.1]:2222' -f $knownHosts *> $null
Assert-Success 'Mac host-key lookup'

$relayTarget = "$relayUser@$relayHost"
$macTarget = "$macUser@127.0.0.1"
$relayIdentity = [Environment]::GetEnvironmentVariable('MISSION_AI_RELAY_IDENTITY_FILE', 'Process')
if ([string]::IsNullOrWhiteSpace($relayIdentity)) { $relayIdentity = $privateKey }
if (-not (Test-Path -LiteralPath $relayIdentity -PathType Leaf)) {
    throw 'The relay SSH identity file is missing.'
}
$macSshArgs = @(
    '-p', '2222', '-i', $privateKey, '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$knownHosts", '-o', 'ConnectTimeout=5'
)
$runtimeDirectory = Join-Path $env:TEMP 'MissionAI-Relay'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$relayErrorLog = Join-Path $runtimeDirectory 'office-forward.err.log'
$forward = $null
$completed = $false

try {
    if (-not (Test-LocalPort 2222)) {
        $forwardArguments = @(
            '-N', '-T', '-i', $relayIdentity, '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', "UserKnownHostsFile=$knownHosts",
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
            '-o', 'ServerAliveCountMax=3',
            '-L', '127.0.0.1:2222:127.0.0.1:2222', $relayTarget
        )
        $forward = Start-Process -FilePath $ssh -ArgumentList $forwardArguments -WindowStyle Hidden -PassThru -RedirectStandardError $relayErrorLog
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $macReady = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($forward -and $forward.HasExited) {
            throw "The relay forward exited; inspect $relayErrorLog."
        }
        if (Test-LocalPort 2222) {
            & $ssh @macSshArgs $macTarget 'printf MAC_READY' *> $null
            if ($LASTEXITCODE -eq 0) {
                $macReady = $true
                break
            }
        }
        Start-Sleep -Seconds 5
    }
    if (-not $macReady) {
        throw 'The Mac-side reverse SSH forward or Mac key authorization is unavailable.'
    }

    $remoteHome = (& $ssh @macSshArgs $macTarget 'printf "%s" "$HOME"')
    Assert-Success 'Remote home lookup'
    if ($remoteHome -notmatch '^/[A-Za-z0-9_./-]+$') {
        throw 'Remote home path cannot be safely used for SCP.'
    }
    $remoteDirectory = "$remoteHome/LibreChat/mission-ai/local-worker"
    & $ssh @macSshArgs $macTarget "mkdir -p '$remoteDirectory'"
    Assert-Success 'Remote worker directory creation'

    $worker = Join-Path $PSScriptRoot '..\local-worker\local_mcp_agent.py'
    $provision = Join-Path $PSScriptRoot '..\local-worker\remote_mac_provision.sh'
    foreach ($path in @($worker, $provision)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required worker file is missing: $path"
        }
    }
    $scpArgs = @(
        '-P', '2222', '-i', $privateKey, '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$knownHosts"
    )
    $remoteWorker = ('{0}:{1}/local_mcp_agent.py' -f $macTarget, $remoteDirectory)
    $remoteProvision = ('{0}:{1}/remote_mac_provision.sh' -f $macTarget, $remoteDirectory)
    & $scp @scpArgs $worker $remoteWorker
    Assert-Success 'Worker transfer'
    & $scp @scpArgs $provision $remoteProvision
    Assert-Success 'Provisioner transfer'

    $environment = [ordered]@{
        LOCAL_MCP_PUBLIC_URL = $publicUrl
        LOCAL_MCP_TOKEN = $token
        LOCAL_MCP_OWNER_USER_ID = $ownerId
        LOCAL_MCP_ALLOWED_ORIGINS = $origins
    }
    $macRoot = [Environment]::GetEnvironmentVariable('MISSION_AI_MAC_ROOT', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($macRoot)) {
        if ($macRoot -notmatch '^/[^\r\n\x00]+$') {
            throw 'MISSION_AI_MAC_ROOT must be an absolute path on the Mac.'
        }
        $environment.LOCAL_MCP_ROOT = $macRoot
    }
    $payload = ConvertTo-Json -InputObject $environment -Compress
    $payload | & $ssh @macSshArgs $macTarget "bash '$remoteDirectory/remote_mac_provision.sh' --env-stdin"
    Assert-Success 'Mac worker provisioning'
    $payload = $null
    $completed = $true
    Write-Output 'Mac worker started on 127.0.0.1:5000; office SSH forward remains active.'
} finally {
    if (-not $completed -and $forward -and -not $forward.HasExited) {
        Stop-Process -Id $forward.Id -Force
    }
}
