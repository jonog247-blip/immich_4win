<#
  Makes Immich start with Windows.

  This is a per user Scheduled Task, not a Windows service: Immich is a supervised set of ordinary
  processes (PostgreSQL, Redis, the server, machine learning), and the supervisor already restarts a
  component that dies. Running it at logon means no administrator password is stored anywhere and
  the tray of background processes stays visible to the user who owns the photos.

    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action install
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action start
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action stop
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 -Action uninstall

  Installing for every user of the PC needs an elevated prompt; per user it does not.
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop')]
  [string]$Action = 'status',
  [string]$Root,
  [string]$TaskName = 'Immich4Win',
  [switch]$AllUsers
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $Root = Split-Path -Parent $scriptDir
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$Exe = Join-Path $Root 'Immich.exe'

function Write-Detail {
  param([string]$Message, [string]$Color = 'DarkGray')
  Write-Host "    $Message" -ForegroundColor $Color
}

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "Immich.exe is missing from $Root"
}

try {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  $existing = $null
}

switch ($Action) {
  'install' {
    Write-Host ''
    Write-Host "  Starting Immich with Windows" -ForegroundColor Cyan

    if ($existing) {
      Write-Detail 'replacing the existing task'
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    # --foreground keeps the supervisor in this one task instance: the task owns the process tree,
    # so Stop-ScheduledTask and logoff both take the database down cleanly
    $arguments = "`"$Exe`" start --no-browser --foreground"
    $action = New-ScheduledTaskAction -Execute $Exe -Argument 'start --no-browser --foreground' -WorkingDirectory $Root

    # A short delay lets Windows settle the network stack and the disk queues after logon
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $trigger.Delay = 'PT30S'

    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1)

    # A photo server that stops on battery or on idle is a bug, so both are turned off explicitly
    $settings.IdleSettings.StopOnIdleEnd = $false
    $settings.DisallowStartIfOnBatteries = $false

    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
      -LogonType Interactive -RunLevel Limited

    if ($AllUsers) {
      $principal = New-ScheduledTaskPrincipal -GroupId 'Users' -RunLevel Limited
      Write-Detail 'installing for every user of this PC'
    }

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Principal $principal -Description 'Immich photo and video server (Immich4Win)' | Out-Null

    Write-Detail "scheduled task '$TaskName' created; arguments: $arguments"
    Write-Detail 'Immich now starts 30 seconds after you log on'
    Write-Host ''
    Write-Host '  Start it now with:  Immich.bat' -ForegroundColor Gray
  }

  'uninstall' {
    Write-Host ''
    if (-not $existing) {
      Write-Detail "no scheduled task named '$TaskName'"
      exit 0
    }

    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Write-Detail 'task stopped'
    } catch {
      Write-Detail 'task was not running'
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Detail "scheduled task '$TaskName' removed"
    Write-Host ''
    Write-Host '  Immich will not start with Windows any more.' -ForegroundColor Gray
  }

  'status' {
    Write-Host ''
    if (-not $existing) {
      Write-Detail "no scheduled task named '$TaskName' (Immich does not start with Windows)"
    } else {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Detail "task '$TaskName' is $($existing.State)"
      Write-Detail "last run: $($info.LastRunTime), result $($info.LastTaskResult)"
    }

    Write-Host ''
    Write-Host '  Runtime state:' -ForegroundColor Gray
    & $Exe status
  }

  'start' {
    if (-not $existing) {
      throw "no scheduled task named '$TaskName'; run -Action install first"
    }

    Start-ScheduledTask -TaskName $TaskName
    Write-Detail "started '$TaskName'"
  }

  'stop' {
    if (-not $existing) {
      Write-Host ''
      Write-Detail "no scheduled task named '$TaskName'; stopping Immich directly"
      & $Exe stop
      exit 0
    }

    # Stopping the task ends the supervisor, which stops PostgreSQL and Redis in order; the direct
    # stop call then sweeps anything the task could not reach
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Write-Detail "stopped '$TaskName'"
    } catch {
      Write-Detail 'task was not running'
    }

    Start-Sleep -Seconds 2
    & $Exe stop
  }
}

exit 0
