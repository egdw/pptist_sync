param(
  [string]$OutputName = "pptist-rk3588-lcd-deploy",
  [switch]$SkipFrontendBuild
)

$scriptArgs = @{ OutputName = $OutputName }
if ($SkipFrontendBuild) { $scriptArgs.SkipFrontendBuild = $true }
& "$PSScriptRoot\scripts\build-rk3588-deploy.ps1" @scriptArgs
