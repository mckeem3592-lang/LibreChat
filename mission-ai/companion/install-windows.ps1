$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$major = [int](((& $node -p 'process.versions.node').Trim() -split '\.')[0])
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
Copy-Item -LiteralPath (Join-Path $source 'launch-windows.ps1') -Destination $destination -Force
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

$hasCredential = & $node (Join-Path $destination 'credential-check.js')
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

$settingsPath = Join-Path $destination 'settings.json'
$previousRepo = $null
if (Test-Path -LiteralPath $settingsPath) {
  try { $previousRepo = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).codeRepository }
  catch { $previousRepo = $null }
}
$settings = @{
  autonomousTools = @('browser.activate_tab', 'browser.open_new_tab', 'browser.open_url_direct',
    'browser.close_tabs', 'browser.click', 'browser.type', 'browser.scroll', 'browser.open_url',
    'file.move', 'file.write', 'repo.write', 'repo.check')
  fileRoots = @{
    Desktop = [Environment]::GetFolderPath('Desktop')
    Documents = [Environment]::GetFolderPath('MyDocuments')
    Downloads = (Join-Path $env:USERPROFILE 'Downloads')
  }
}
if ($env:MISSION_AI_CODE_REPO_ROOT) {
  $selectedRepo = [System.IO.Path]::GetFullPath($env:MISSION_AI_CODE_REPO_ROOT)
  if (-not (Test-Path -LiteralPath (Join-Path $selectedRepo '.git'))) {
    throw 'MISSION_AI_CODE_REPO_ROOT must identify a Git checkout.'
  }
  $settings.codeRepository = @{
    root = $selectedRepo
    checks = @{
      'diff-check' = @{ command = 'git'; args = @('diff', '--check') }
      'status' = @{ command = 'git'; args = @('status', '--short') }
    }
  }
} elseif ($previousRepo) {
  $settings.codeRepository = $previousRepo
}
$settingsJson = $settings | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($settingsPath, $settingsJson)

$launcherArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $destination 'launch-windows.ps1') + '"'
$runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
try {
  $runKey.SetValue('MissionAICompanion', '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" ' + $launcherArgs)
} finally { $runKey.Close() }
Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList $launcherArgs -WindowStyle Hidden

Write-Host 'Mission AI companion installed for this Windows account.'
Write-Host "Next: Chrome > Extensions > Developer mode > Load unpacked, then select $extensionDestination"
Write-Host 'The companion works with selected tabs in the background after the Chrome extension connects.'
