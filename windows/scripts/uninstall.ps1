<#
  Removes Immich4Win.

  By default only the program folder is removed. Your photos, the database and the backups live in
  %LOCALAPPDATA%\Immich4Win and are kept, so a reinstall picks up exactly where this one left off.

    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveData       delete photos too
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -WhatIf           list changes only

  -RemoveData asks for confirmation unless -Force is given, because there is no undo.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$Root,
  [switch]$RemoveData,
  [switch]$KeepData,
  [switch]$Force,
  [string]$TaskName = 'Immich4Win',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $Root = Split-Path -Parent $scriptDir
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$Exe = Join-Path $Root 'Immich.exe'
$DataHome = Join-Path $env:LOCALAPPDATA 'Immich4Win'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-Detail {
  param([string]$Message, [string]$Color = 'DarkGray')
  Write-Host "    $Message" -ForegroundColor $Color
}

$dataSize = 0
if (Test-Path -LiteralPath $DataHome) {
  $dataSize = (Get-ChildItem -LiteralPath $DataHome -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
}

Write-Step 'Immich4Win removal'

Write-Host "  program   $Root" -ForegroundColor Gray
Write-Host "  your data $DataHome ($([math]::Round($dataSize / 1GB, 2)) GB)" -ForegroundColor Gray

if ($RemoveData -and -not $Force) {
  Write-Host ''
  Write-Host '  -RemoveData deletes every photo, the database and all backups in the folder above.' -ForegroundColor Yellow
  Write-Host '  This cannot be undone.' -ForegroundColor Yellow
  $answer = Read-Host '  Type DELETE to confirm'
  if ($answer -ne 'DELETE') {
    Write-Detail 'cancelled; nothing was changed'
    exit 1
  }
}

if ($KeepData) { $RemoveData = $false }

# ---------------------------------------------------------------- stop everything

Write-Step 'Stopping Immich'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if ($DryRun) {
    Write-Detail "would remove the scheduled task '$TaskName'"
  } else {
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Write-Detail "stopped scheduled task '$TaskName'"
    } catch {
      Write-Detail 'scheduled task was not running'
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Detail "removed scheduled task '$TaskName'"
  }
} else {
  Write-Detail 'no scheduled task installed'
}

if (-not $DryRun -and (Test-Path -LiteralPath $Exe)) {
  # The exe stops PostgreSQL with a clean shutdown; killing the process instead risks a crash
  # recovery on the next start, so this is always tried first
  & $Exe stop 2>&1 | ForEach-Object { Write-Detail $_ }
} elseif ($DryRun) {
  Write-Detail 'would stop the database and every Immich process'
}

# ---------------------------------------------------------------- shortcuts

Write-Step 'Removing shortcuts'

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut = Get-ChildItem -LiteralPath $startMenu -Recurse -Filter 'Immich*.lnk' -ErrorAction SilentlyContinue
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Immich.lnk'

foreach ($item in @($shortcut) + @(if (Test-Path -LiteralPath $desktopShortcut) { Get-Item -LiteralPath $desktopShortcut })) {
  if ($item -and $item.FullName) {
    if ($DryRun) {
      Write-Detail "would remove $($item.FullName)"
    } else {
      Remove-Item -LiteralPath $item.FullName -Force
      Write-Detail "removed $($item.Name)"
    }
  }
}

# ---------------------------------------------------------------- environment

Write-Step 'Removing environment settings'

foreach ($name in @('IMMICH4WIN_ROOT', 'IMMICH_HOME')) {
  $current = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($current) {
    if ($DryRun) {
      Write-Detail "would remove the user variable $name"
    } else {
      [Environment]::SetEnvironmentVariable($name, $null, 'User')
      Write-Detail "removed the user variable $name"
    }
  }
}

# ---------------------------------------------------------------- program folder

Write-Step 'Removing the program'

# Immich.exe cannot delete the folder it runs from, so the removal is handed to a detached command
# that waits a moment and then removes both the folder and itself
if (-not $DryRun) {
  $cleanup = Join-Path $env:TEMP "immich4win-uninstall-$([guid]::NewGuid().ToString('N')).cmd"
  $removeDataLine = ''
  if ($RemoveData) {
    $removeDataLine = "rd /s /q `"$DataHome`" 2>nul"
  }

  $script = @"
@echo off
timeout /t 3 /nobreak >nul
rd /s /q "$Root" 2>nul
$removeDataLine
del /f /q "%~f0" 2>nul
"@
  Set-Content -LiteralPath $cleanup -Value $script -Encoding ASCII
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cleanup) -WindowStyle Hidden
  Write-Detail "the folder above is removed in a few seconds"
} else {
  Write-Detail "would remove $Root"
  if ($RemoveData) {
    Write-Detail "would remove $DataHome"
  }
}

# ---------------------------------------------------------------- summary

Write-Step 'Done'

if ($RemoveData) {
  Write-Host '  Immich4Win, your photos and the database have been removed.' -ForegroundColor Green
} else {
  Write-Host '  Immich4Win has been removed.' -ForegroundColor Green
  if (Test-Path -LiteralPath $DataHome) {
    Write-Host "  Your photos, database and backups are still in $DataHome" -ForegroundColor Gray
    Write-Host '  Delete that folder yourself to free the space.' -ForegroundColor Gray
  }
}

exit 0
