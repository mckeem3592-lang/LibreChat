param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$PublicKeyPath = (Join-Path $env:USERPROFILE '.ssh\mission_ai_mac_ed25519.pub'),
    [switch]$GenerateIfMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
if (-not (Test-Path -LiteralPath $keygen -PathType Leaf)) {
    throw 'Windows OpenSSH ssh-keygen.exe is required.'
}

$PublicKeyPath = [System.IO.Path]::GetFullPath($PublicKeyPath)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$privateKeyPath = $PublicKeyPath -replace '\.pub$', ''
if ($privateKeyPath -eq $PublicKeyPath) { throw 'PublicKeyPath must end in .pub.' }
if ($OutputPath -eq $PublicKeyPath -or $OutputPath -eq $privateKeyPath) {
    throw 'OutputPath must not replace either SSH key file.'
}

if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
    if (-not $GenerateIfMissing) { throw "Office public key is missing: $PublicKeyPath" }
    if (Test-Path -LiteralPath $privateKeyPath) {
        throw 'Private key exists without the public key; refusing to replace it.'
    }
    $keyDirectory = Split-Path -Parent $PublicKeyPath
    [System.IO.Directory]::CreateDirectory($keyDirectory) | Out-Null
    & $keygen -q -t ed25519 -a 100 -f $privateKeyPath -N '""'
    if ($LASTEXITCODE -ne 0) { throw 'SSH key generation failed.' }
    $userGrant = '{0}\{1}:R' -f $env:USERDOMAIN, $env:USERNAME
    & icacls.exe $privateKeyPath /inheritance:r /grant:r $userGrant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private-key ACL restriction failed.' }
}

$lines = @(Get-Content -LiteralPath $PublicKeyPath -Encoding UTF8)
if ($lines.Count -ne 1 -or $lines[0] -notmatch '^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$') {
    throw 'Expected exactly one valid Ed25519 public-key line.'
}
$encodedKey = $Matches[1]
try { $wire = [Convert]::FromBase64String($encodedKey) }
catch { throw 'Public key is not valid Base64.' }
if ($wire.Length -ne 51 -or
    [BitConverter]::ToUInt32([byte[]]($wire[0..3]), 0) -ne 184549376) {
    # Ed25519 SSH wire format: 4-byte length, 11-byte name, 4-byte length, 32-byte key.
    throw 'Public key does not contain an Ed25519 SSH key.'
}
if ([Text.Encoding]::ASCII.GetString($wire, 4, 11) -ne 'ssh-ed25519' -or
    $wire[15] -ne 0 -or $wire[16] -ne 0 -or $wire[17] -ne 0 -or $wire[18] -ne 32) {
    throw 'Public key SSH wire format is invalid.'
}

$entry = 'restrict,port-forwarding,permitopen="127.0.0.1:2222" ssh-ed25519 {0} mission-ai-office' -f $encodedKey
$outputDirectory = Split-Path -Parent $OutputPath
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
if (Test-Path -LiteralPath $OutputPath) { throw 'OutputPath already exists; refusing to overwrite it.' }
[System.IO.File]::WriteAllText($OutputPath, "$entry`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "STAGED_AUTHORIZED_KEY=$OutputPath"
