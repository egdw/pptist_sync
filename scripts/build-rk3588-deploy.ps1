param(
  [string]$OutputName = "pptist-rk3588-lcd-deploy"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DeployRoot = Join-Path $ProjectRoot "deploy"
$StageDir = Join-Path $DeployRoot $OutputName
$ArchivePath = Join-Path $DeployRoot "$OutputName.tar.gz"

if (-not $StageDir.StartsWith($DeployRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe output path: $StageDir"
}

Write-Host "[1/6] Building frontend..." -ForegroundColor Cyan
Push-Location $ProjectRoot
try { npm run build-only } finally { Pop-Location }

Write-Host "[2/6] Creating clean staging directory..." -ForegroundColor Cyan
if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir | Out-Null

Copy-Item -Recurse -Force (Join-Path $ProjectRoot "dist") (Join-Path $StageDir "dist")
Copy-Item -Recurse -Force (Join-Path $ProjectRoot "server") (Join-Path $StageDir "server")
Copy-Item -Recurse -Force (Join-Path $ProjectRoot "reveal-example") (Join-Path $StageDir "reveal-example")
Copy-Item -Recurse -Force (Join-Path $ProjectRoot "doc") (Join-Path $StageDir "doc")
Copy-Item -Force (Join-Path $ProjectRoot "LICENSE") $StageDir
Copy-Item -Force (Join-Path $ProjectRoot "public\logo.png") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\setup.sh") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\start-pptist.sh") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\stop-pptist.sh") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\service-run.sh") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\enable-boot-service.sh") $StageDir
Copy-Item -Force (Join-Path $DeployRoot "pptist\disable-boot-service.sh") $StageDir
$DeployReadme = Get-ChildItem -LiteralPath (Join-Path $DeployRoot "pptist") -Filter "*.md" | Select-Object -First 1
if ($DeployReadme) { Copy-Item -Force $DeployReadme.FullName $StageDir }

New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "src\assets\fonts") | Out-Null
Copy-Item -Force (Join-Path $ProjectRoot "src\assets\fonts\MiSans.woff2") (Join-Path $StageDir "src\assets\fonts\MiSans.woff2")
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "data\default-ppt\versions"), (Join-Path $StageDir "data\secondary-ppt\versions"), (Join-Path $StageDir "data\led-cache"), (Join-Path $StageDir "data\led-assets\portraits") | Out-Null

Write-Host "[3/6] Adding offline Node.js ARM64 runtime..." -ForegroundColor Cyan
$RuntimeSource = Get-ChildItem -LiteralPath (Join-Path $DeployRoot "pptist\runtime") -Filter "node-v*-linux-arm64.tar.xz" | Select-Object -First 1
if (-not $RuntimeSource) { throw "Missing deploy/pptist/runtime/node-v*-linux-arm64.tar.xz" }
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "runtime") | Out-Null
Copy-Item -Force $RuntimeSource.FullName (Join-Path $StageDir "runtime")

Write-Host "[4/6] Installing Linux ARM64 server dependencies..." -ForegroundColor Cyan
$ServerDir = Join-Path $StageDir "server"
Copy-Item -Force (Join-Path $DeployRoot "server-package.json") (Join-Path $ServerDir "package.json")
Push-Location $ServerDir
try {
  $OldNpmOs = $env:npm_config_os
  $OldNpmCpu = $env:npm_config_cpu
  $OldNpmLibc = $env:npm_config_libc
  $env:npm_config_os = "linux"
  $env:npm_config_cpu = "arm64"
  $env:npm_config_libc = "glibc"
  # --force is intentional: this Windows build host is packaging a Linux ARM64 native module.
  npm install --omit=dev --no-audit --no-fund --force
} finally { Pop-Location }
$env:npm_config_os = $OldNpmOs
$env:npm_config_cpu = $OldNpmCpu
$env:npm_config_libc = $OldNpmLibc

if (-not (Test-Path (Join-Path $ServerDir "node_modules\@napi-rs\canvas-linux-arm64-gnu"))) {
  throw "ARM64 Canvas native package was not generated"
}

Write-Host "[5/6] Writing build information..." -ForegroundColor Cyan
$Version = Get-Date -Format "yyyyMMdd-HHmmss"
@("PPTist RK3588 LCD deployment", "Build: $Version", "Node: $($RuntimeSource.Name)") | Set-Content -Encoding UTF8 (Join-Path $StageDir "BUILD-INFO.txt")

Write-Host "[6/6] Creating tar.gz archive..." -ForegroundColor Cyan
if (Test-Path -LiteralPath $ArchivePath) { Remove-Item -LiteralPath $ArchivePath -Force }
Push-Location $DeployRoot
try { tar -czf "$OutputName.tar.gz" $OutputName } finally { Pop-Location }

$SizeMB = [math]::Round((Get-Item $ArchivePath).Length / 1MB, 1)
Write-Host "Done: $ArchivePath ($SizeMB MB)" -ForegroundColor Green
Write-Host "On RK3588: extract the archive and run: bash setup.sh" -ForegroundColor Green
