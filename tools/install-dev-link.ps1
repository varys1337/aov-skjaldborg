param(
  [string]$FoundryDataPath = "$env:LOCALAPPDATA\FoundryVTT\Data",
  [ValidateSet("Link", "Copy")]
  [string]$InstallMode = "Link",
  [switch]$Replace
)

$ErrorActionPreference = "Stop"

$moduleId = "aov-skjadlborg"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataRoot = Resolve-Path $FoundryDataPath
$modulesRoot = Join-Path $dataRoot "modules"
$targetPath = Join-Path $modulesRoot $moduleId

if (-not (Test-Path -LiteralPath $modulesRoot)) {
  New-Item -ItemType Directory -Path $modulesRoot | Out-Null
}

if (Test-Path -LiteralPath $targetPath) {
  $existing = Get-Item -LiteralPath $targetPath -Force
  if ($InstallMode -eq "Copy") {
    if (-not $Replace) {
      throw "A module folder already exists at '$targetPath'. Re-run with -Replace to refresh a copy install."
    }
    $resolvedTarget = Resolve-Path $targetPath
    $resolvedModulesRoot = Resolve-Path $modulesRoot
    if ((Split-Path -Leaf $resolvedTarget.Path) -ne $moduleId) {
      throw "Refusing to remove unexpected path '$($resolvedTarget.Path)'."
    }
    if ((Split-Path -Parent $resolvedTarget.Path) -ne $resolvedModulesRoot.Path) {
      throw "Refusing to remove path outside modules folder '$($resolvedTarget.Path)'."
    }
    Remove-Item -LiteralPath $resolvedTarget.Path -Recurse -Force
  }
  elseif ($existing.LinkType -and $existing.Target) {
    $resolvedTarget = Resolve-Path $existing.Target
    if ($resolvedTarget.Path -eq $projectRoot.Path) {
      Write-Host "Foundry dev link already points to $($projectRoot.Path)"
      exit 0
    }
    throw "Existing Foundry module link points to '$($existing.Target)', not '$($projectRoot.Path)'. Remove it manually if you want to replace it."
  }
  else {
    throw "A real folder or file already exists at '$targetPath'. This script will not overwrite it."
  }
}

if ($InstallMode -eq "Copy") {
  Copy-Item -LiteralPath $projectRoot.Path -Destination $targetPath -Recurse
  Write-Host "Copied module: $($projectRoot.Path) -> $targetPath"
  exit 0
}

try {
  New-Item -ItemType SymbolicLink -Path $targetPath -Target $projectRoot.Path | Out-Null
  Write-Host "Created symbolic link: $targetPath -> $($projectRoot.Path)"
}
catch {
  New-Item -ItemType Junction -Path $targetPath -Target $projectRoot.Path | Out-Null
  Write-Host "Created junction: $targetPath -> $($projectRoot.Path)"
}
