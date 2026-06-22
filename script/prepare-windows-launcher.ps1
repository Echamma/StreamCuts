Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$backendDir = Join-Path $repoRoot "backend\long-to-short"
$webDir = Join-Path $repoRoot "opencut-classic\apps\web"

Write-Host "Preparing backend..."
Push-Location $backendDir
try {
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "Backend npm install failed."
  }
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "Backend npm run build failed."
  }
}
finally {
  Pop-Location
}

Write-Host "Preparing frontend production build..."
Push-Location $webDir
try {
  npm install --no-package-lock --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend npm install failed."
  }
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend npm run build failed."
  }
}
finally {
  Pop-Location
}

& (Join-Path $scriptDir "build-windows-launcher.ps1")
