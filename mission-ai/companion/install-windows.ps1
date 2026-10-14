$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$major = [int]((& $node -p 'process.versions.node.split(".")[0]').Trim())
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

$source = $PSScriptRoot
$destination = Join-Path $env:LOCALAPPDATA 'MissionAI\Bridge'
$extensionSource = Join-Path (Split-Path -Parent $source) 'chrome-extension'
$extensionDestination = Join-Path $env:LOCALAPPDATA 'MissionAI\ChromeExtension'
if (-not (Test-Path (Join-Path $extensionSource 'manifest.json'))) { throw 'Chrome extension package is missing.' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
New-Item -ItemType Directory -Force -Path $extensionDestination | Out-Null
Get-ChildItem -Path $source -File | Where-Object { $_.Extension -in '.js', '.json', '.cs' } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Force }
Get-ChildItem -Path $extensionSource -File |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $extensionDestination -Force }
$localNode = Join-Path $destination 'node.exe'
if ($node -ne $localNode) { Copy-Item -LiteralPath $node -Destination $localNode -Force }
$node = $localNode

Set-Location $destination
$bundledWs = Join-Path $source 'node_modules\ws'
if (Test-Path -LiteralPath (Join-Path $bundledWs 'package.json')) {
  $moduleDestination = Join-Path $destination 'node_modules'
  New-Item -ItemType Directory -Force -Path $moduleDestination | Out-Null
  Copy-Item -LiteralPath $bundledWs -Destination (Join-Path $moduleDestination 'ws') -Recurse -Force
} else {
  & (Get-Command npm.cmd -ErrorAction Stop).Source ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Companion dependency installation failed.' }
}

$hasCredential = & $node --input-type=module -e 'import {readSecret} from "./keychain.js"; process.stdout.write((await readSecret("mission-ai-device-token")) ? "yes" : "no")'
if ($hasCredential -ne 'yes' -or $env:MISSION_AI_REPAIR_PAIR -eq 'true') {
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

$settings = @{
  autonomousTools = @('browser.activate_tab', 'browser.open_new_tab', 'browser.open_url_direct',
    'browser.close_tabs', 'browser.click', 'browser.type', 'browser.scroll', 'browser.open_url',
    'file.move', 'file.write')
  fileRoots = @{
    Desktop = [Environment]::GetFolderPath('Desktop')
    Documents = [Environment]::GetFolderPath('MyDocuments')
    Downloads = (Join-Path $env:USERPROFILE 'Downloads')
  }
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText((Join-Path $destination 'settings.json'), $settings)

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $destination 'companion.js') + '"') -WorkingDirectory $destination
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'MissionAICompanion' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'MissionAICompanion'

Write-Host 'Mission AI companion installed for this Windows account.'
Write-Host "Next: Chrome > Extensions > Developer mode > Load unpacked, then select $extensionDestination"
Write-Host 'The companion works with selected tabs in the background after the Chrome extension connects.'
