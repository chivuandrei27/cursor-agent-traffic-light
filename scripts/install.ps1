# Bootstrap for Windows machines with no Node / Node < 18.
$ErrorActionPreference = "Stop"

$NodeVersion = "22.18.0"
$AppHome = Join-Path $env:USERPROFILE ".cursor-agent-traffic-light"
$RuntimeDir = Join-Path $AppHome "runtime"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Triple = "win-x64"
$Archive = "node-v$NodeVersion-$Triple.zip"
$Url = "https://nodejs.org/dist/v$NodeVersion/$Archive"
$Prefix = Join-Path $RuntimeDir "node-v$NodeVersion-$Triple"
$NodeBin = Join-Path $Prefix "node.exe"

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

if (-not (Test-Path $NodeBin)) {
  Write-Host "[install] Downloading Node $NodeVersion ($Triple)..."
  $Tmp = Join-Path $RuntimeDir $Archive
  Invoke-WebRequest -Uri $Url -OutFile $Tmp
  Expand-Archive -Path $Tmp -DestinationPath $RuntimeDir -Force
  Remove-Item $Tmp -Force
}

Write-Host "[install] Using $NodeBin"
Set-Location $Root
$env:PATH = "$(Split-Path $NodeBin -Parent);$env:PATH"

if (-not (Test-Path (Join-Path $Root "node_modules\ws"))) {
  Write-Host "[install] npm install..."
  npm install --omit=dev --no-fund --no-audit
}

& $NodeBin (Join-Path $Root "scripts\setup.mjs") @args
