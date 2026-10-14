$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$major = [int]((& $node -p 'process.versions.node.split(".")[0]').Trim())
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

$source = $PSScriptRoot
$destination = Join-Path $env:LOCALAPPDATA 'MissionAI\Bridge'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem -Path $source -File | Where-Object { $_.Extension -in '.js', '.json', '.cs' } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Force }

Set-Location $destination
& (Get-Command npm.cmd -ErrorAction Stop).Source ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Companion dependency installation failed.' }

$hasCredential = & $node --input-type=module -e 'import {readSecret} from "./keychain.js"; process.stdout.write((await readSecret("mission-ai-device-token")) ? "yes" : "no")'
if ($hasCredential -ne 'yes') {
  & $node (Join-Path $destination 'pair-windows.js')
  if ($LASTEXITCODE -ne 0) { throw 'Device pairing failed; no background service was installed.' }
}

$launcherSource = Join-Path $destination 'NativeHostLauncher.cs'
$launcher = Join-Path $destination 'MissionAINativeHost.exe'
if (Test-Path $launcher) { Remove-Item -LiteralPath $launcher -Force }
Add-Type -Path $launcherSource -OutputAssembly $launcher -OutputType ConsoleApplication
[System.IO.File]::WriteAllText((Join-Path $destination 'node-path.txt'), $node)

$manifest = @{
  name = 'com.missionai.browser_bridge'
  description = 'Mission AI local Chrome bridge'
  path = $launcher
  type = 'stdio'
  allowed_origins = @('chrome-extension://ggkpmldfojmlehhbadliodeplhneelmb/')
} | ConvertTo-Json -Depth 4
$manifestPath = Join-Path $destination 'com.missionai.browser_bridge.json'
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Google\Chrome\NativeMessagingHosts\com.missionai.browser_bridge')
try { $key.SetValue('', $manifestPath) } finally { $key.Close() }

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $destination 'companion.js') + '"') -WorkingDirectory $destination
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'MissionAICompanion' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'MissionAICompanion'

Write-Host 'Mission AI companion installed for this Windows account.'
Write-Host 'Next: Chrome > Extensions > Developer mode > Load unpacked, then select the chrome-extension folder in this download.'
Write-Host 'The companion works with selected tabs in the background after the Chrome extension connects.'
