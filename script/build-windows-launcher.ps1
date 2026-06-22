Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$launcherDir = Join-Path $repoRoot "launcher"
$outputDir = Join-Path $repoRoot "dist\windows"
$outputPath = Join-Path $outputDir "StreamCutsLauncher.exe"

Write-Host "Building Windows launcher..."
Push-Location $launcherDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build --release failed."
  }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force `
  (Join-Path $launcherDir "target\release\streamcuts-launcher.exe") `
  $outputPath

Write-Host "Launcher built at $outputPath"
