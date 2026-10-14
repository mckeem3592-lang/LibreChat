$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'companion.log'
try {
  & (Join-Path $PSScriptRoot 'node.exe') (Join-Path $PSScriptRoot 'companion.js') *>> $log
  exit $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -LiteralPath $log
  exit 1
}
