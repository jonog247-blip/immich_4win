<#
  Downloads the place name data Immich uses for reverse geocoding, so a photo taken in London shows
  "London, England" instead of 51.5074, -0.1278.

  The files are the same five the official container image bakes in. They are about 200 MB
  compressed, mostly the cities list.

    powershell -ExecutionPolicy Bypass -File scripts\install-geodata.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-geodata.ps1 -Force    re-download

  Immich.exe geodata download does the same thing and is what a user normally runs.
#>
[CmdletBinding()]
param(
  [string]$Root,
  [switch]$Force,
  [int]$Retries = 4
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $Root = Split-Path -Parent $scriptDir
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$Cache = Join-Path $Root '.downloads'
$GeodataDir = Join-Path $Root 'runtime\build\geodata'
$StateDir = Join-Path $Root 'state'
New-Item -ItemType Directory -Force -Path $Cache, $GeodataDir, $StateDir | Out-Null

function Write-Detail {
  param([string]$Message, [string]$Color = 'DarkGray')
  Write-Host "    $Message" -ForegroundColor $Color
}

# The exact list the Immich base image downloads; a subset would break some countries quietly
$sources = @(
  @{ Url = 'https://download.geonames.org/export/dump/cities500.zip'; File = 'cities500.txt'; Kind = 'zip' },
  @{ Url = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'; File = 'admin1CodesASCII.txt'; Kind = 'text' },
  @{ Url = 'https://download.geonames.org/export/dump/admin2Codes.txt'; File = 'admin2Codes.txt'; Kind = 'text' },
  @{ Url = 'https://download.geonames.org/export/dump/countryInfo.txt'; File = 'countryInfo.txt'; Kind = 'text' },
  @{ Url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson'; File = 'ne_10m_admin_0_countries.geojson'; Kind = 'text' }
)

Write-Host ''
Write-Host '  Place names for reverse geocoding' -ForegroundColor Cyan

$failures = @()
foreach ($source in $sources) {
  $target = Join-Path $GeodataDir $source.File
  if ((Test-Path -LiteralPath $target) -and -not $Force -and (Get-Item -LiteralPath $target).Length -gt 0) {
    Write-Detail "$($source.File) is already there"
    continue
  }

  $download = Join-Path $Cache (Split-Path -Leaf $source.Url)
  $success = $false
  for ($attempt = 1; $attempt -le $Retries -and -not $success; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $download) -or $Force) {
        Write-Detail "downloading $([System.IO.Path]::GetFileName($source.Url)) (attempt $attempt)"
        $process = Start-Process -FilePath 'curl.exe' -ArgumentList @(
          '-fL', '--retry', '3', '--connect-timeout', '30', '--max-time', '3600', '-o', "$download.part", $source.Url
        ) -NoNewWindow -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "curl exited with $($process.ExitCode)" }
        Move-Item -LiteralPath "$download.part" -Destination $download -Force
      }

      if ($source.Kind -eq 'zip') {
        # the geonames archives contain a readme as well; only the data file is wanted
        $staging = Join-Path $Cache "geodata-$($source.File)"
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        & tar.exe -xf $download -C $staging
        if ($LASTEXITCODE -ne 0) { throw "tar.exe could not unpack $download" }
        $extracted = Join-Path $staging $source.File
        if (-not (Test-Path -LiteralPath $extracted)) { throw "$($source.File) is not in the archive" }
        Copy-Item -LiteralPath $extracted -Destination $target -Force
      } else {
        Copy-Item -LiteralPath $download -Destination $target -Force
      }

      $size = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1)
      Write-Detail "$($source.File) ($size MB)"
      $success = $true
    } catch {
      Remove-Item -LiteralPath "$download.part" -Force -ErrorAction SilentlyContinue
      if ($attempt -eq $Retries) {
        $failures += "$($source.File): $($_.Exception.Message)"
        Write-Detail "failed: $($_.Exception.Message)" 'Red'
      } else {
        Start-Sleep -Seconds ([math]::Pow(2, $attempt))
      }
    }
  }
}

# Immich records which data set is loaded; without this file it reloads on every start
Set-Content -LiteralPath (Join-Path $GeodataDir 'geodata-date.txt') -Value (Get-Date -Format 'yyyyMMddHHmmss') -Encoding ASCII

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host '  Place names are ready.' -ForegroundColor Green
  exit 0
}

Write-Host '  Some place name files could not be downloaded:' -ForegroundColor Yellow
foreach ($failure in $failures) {
  Write-Host "    - $failure" -ForegroundColor Yellow
}
Write-Host '  Reverse geocoding works for the files that did arrive; run this again for the rest.' -ForegroundColor Gray
exit 1
