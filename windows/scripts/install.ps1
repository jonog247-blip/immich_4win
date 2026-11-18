<#
  Immich4Win setup: downloads the Windows binaries the portable build needs and prepares this
  folder to be started with Immich.bat.

  Everything lands inside the folder the script sits in. Nothing is installed system wide, no
  registry keys are written and no administrator rights are needed unless -InstallService is used.

  Usage (PowerShell, in the Immich4Win folder):

    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipMl        no AI features
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallService start with Windows
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Force         re-download

  -SkipElevationCheck exists for unattended runs; it does not grant any rights.
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipMl,
  [switch]$SkipGeodata,
  [switch]$InstallService,
  [switch]$SkipElevationCheck,
  [string]$Root,
  [int]$Retries = 4
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- paths and toolchain

if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $Root = Split-Path -Parent $scriptDir
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$Toolchain = Get-Content -LiteralPath (Join-Path $Root 'toolchain.json') -Raw | ConvertFrom-Json

$Cache = Join-Path $Root '.downloads'
$Runtime = Join-Path $Root 'runtime'
$State = Join-Path $Root 'state'
New-Item -ItemType Directory -Force -Path $Cache, $Runtime, $State | Out-Null

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-Detail {
  param([string]$Message, [string]$Color = 'DarkGray')
  Write-Host "    $Message" -ForegroundColor $Color
}

function Write-Skip {
  param([string]$Message)
  Write-Host "    skipped: $Message" -ForegroundColor DarkYellow
}

$script:Failures = New-Object System.Collections.Generic.List[string]
function Add-Failure {
  param([string]$Component, [string]$Message)
  $script:Failures.Add("${Component}: $Message")
}

# ---------------------------------------------------------------- prerequisites

Write-Step "Checking this PC"

if (-not $SkipElevationCheck) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) {
    Write-Detail 'running as administrator'
  } else {
    Write-Detail 'running as a normal user (this is enough; -InstallService needs administrator)'
  }
}

if ([Environment]::OSVersion.Version.Major -lt 10) {
  throw 'Windows 10 or newer is required.'
}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -notin @('AMD64', 'x86')) {
  throw "This build is for 64-bit Windows (x64). Detected: $arch."
}

Write-Detail "Windows $([Environment]::OSVersion.Version) / $arch"

# tar.exe and curl.exe ship with Windows 10 1803 onward, which is why the setup can unpack archives
# without shipping 7-Zip
foreach ($tool in @('curl.exe', 'tar.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is missing. Run Windows Update; both are part of Windows 10 1803 and later."
  }
}

Write-Detail 'curl.exe and tar.exe are available'

# TLS 1.2 for older PowerShell 5.1 sessions, otherwise every download fails with a protocol error
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Skip 'could not raise the TLS version for this session'
}

# ---------------------------------------------------------------- download helpers

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Label = ''
  )

  if (-not $Label) { $Label = Split-Path -Leaf $Destination }

  if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    $size = (Get-Item -LiteralPath $Destination).Length
    if ($size -gt 0) {
      Write-Detail "using cached $Label ($([math]::Round($size / 1MB, 1)) MB)"
      return $Destination
    }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  $partial = "$Destination.part"
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      Write-Detail "downloading $Label (attempt $attempt of $Retries)"
      # --retry handles the transport level, the loop handles a proxy resetting the connection
      $curlArgs = @('-fL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '30', '--max-time', '1800', '-o', $partial, $Url)
      $process = Start-Process -FilePath 'curl.exe' -ArgumentList $curlArgs -NoNewWindow -PassThru -Wait
      if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -gt 0) {
        Move-Item -LiteralPath $partial -Destination $Destination -Force
        Write-Detail "saved $Label ($([math]::Round((Get-Item -LiteralPath $Destination).Length / 1MB, 1)) MB)"
        return $Destination
      }

      throw "curl exited with $($process.ExitCode)"
    } catch {
      Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
      if ($attempt -eq $Retries) { throw }
      $wait = [math]::Pow(2, $attempt)
      Write-Detail "retrying in $wait seconds ($($_.Exception.Message))" 'DarkYellow'
      Start-Sleep -Seconds $wait
    }
  }
}

function Expand-ArchiveTo {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  if ($Archive -match '\.(tar\.gz|tgz)$') {
    # Windows tar.exe understands gzip
    & tar.exe -xzf $Archive -C $Destination 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tar.exe could not unpack $Archive" }
  } elseif ($Archive -match '\.zip$') {
    & tar.exe -xf $Archive -C $Destination 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      # tar on older builds cannot read zip; Expand-Archive is the fallback
      Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    }
  } else {
    throw "unknown archive type: $Archive"
  }

  return $Destination
}

function Find-FirstFile {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$MaxDepth = 6
  )

  $found = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name -Depth $MaxDepth -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Install-Tree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  # /E copies empty folders too, /NFL /NDL keeps the console readable, /NJH /NJS drop the summary
  & robocopy.exe $Source $Destination /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE while copying $Source" }
}

function Copy-OneFile {
  param([string]$Source, [string]$Destination)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

# ---------------------------------------------------------------- PostgreSQL + pgvector

Write-Step "PostgreSQL $($Toolchain.postgres.version)"

$pgArchiveName = $Toolchain.postgres.asset -replace '\{version\}', $Toolchain.postgres.version
$pgUrl = "https://github.com/$($Toolchain.postgres.repository)/releases/download/$($Toolchain.postgres.version)/$pgArchiveName"
$pgArchive = Join-Path $Cache $pgArchiveName
$pgExe = Join-Path $Runtime 'postgres\bin\postgres.exe'

try {
  if ((Test-Path -LiteralPath $pgExe) -and -not $Force) {
    Write-Detail 'PostgreSQL is already installed'
  } else {
    Invoke-Download -Url $pgUrl -Destination $pgArchive -Label $pgArchiveName | Out-Null
    $unpacked = Expand-ArchiveTo -Archive $pgArchive -Destination (Join-Path $Cache 'postgres-unpacked')
    $pgHome = Get-ChildItem -LiteralPath $unpacked -Recurse -Directory -Depth 3 -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\postgres.exe') } |
      Select-Object -First 1
    if (-not $pgHome) { throw 'the archive has no bin\postgres.exe' }
    Install-Tree -Source $pgHome.FullName -Destination (Join-Path $Runtime 'postgres')

    # Immich backs up and restores its own database with these, so they are part of the check
    $clients = @('psql.exe', 'pg_dump.exe', 'pg_dumpall.exe', 'pg_restore.exe')
    $missing = $clients | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Runtime "postgres\bin\$_")) }
    if ($missing) { throw "the PostgreSQL build has no client tools: $($missing -join ', ')" }
    Write-Detail "installed, with $($clients -join ', ')"
  }
} catch {
  Add-Failure 'postgres' $_.Exception.Message
  Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

# pgvector must match the PostgreSQL major version exactly, otherwise CREATE EXTENSION fails
Write-Step "pgvector $($Toolchain.pgvector.version)"

try {
  $pgMajor = ($Toolchain.postgres.version -split '\.')[0]
  $vectorVersion = $Toolchain.pgvector.version -replace '^v', ''
  $vectorAsset = $Toolchain.pgvector.asset -replace '\{version\}', $vectorVersion -replace '\{pgMajor\}', $pgMajor
  $vectorUrl = "https://github.com/$($Toolchain.pgvector.repository)/releases/download/$($Toolchain.pgvector.version)/$vectorAsset"
  $vectorArchive = Join-Path $Cache $vectorAsset
  $vectorMarker = Join-Path $Runtime 'postgres\share\extension\vector.control'

  if ((Test-Path -LiteralPath $vectorMarker) -and -not $Force) {
    Write-Detail 'pgvector is already installed'
  } else {
    Invoke-Download -Url $vectorUrl -Destination $vectorArchive -Label $vectorAsset | Out-Null
    $unpacked = Expand-ArchiveTo -Archive $vectorArchive -Destination (Join-Path $Cache 'pgvector-unpacked')
    $control = Find-FirstFile -Root $unpacked -Name 'vector.control'
    $library = Find-FirstFile -Root $unpacked -Name 'vector.dll'
    if (-not $control -or -not $library) { throw 'the package has no vector.control and vector.dll' }

    # PostgreSQL looks in share/extension for the SQL and control file and in lib for the DLL
    $extensionDirs = @((Join-Path $Runtime 'postgres\share\extension'), (Join-Path $Runtime 'postgres\share\postgresql\extension')) |
      Where-Object { Test-Path -LiteralPath (Split-Path -Parent $_) }
    $libraryDirs = @((Join-Path $Runtime 'postgres\lib'), (Join-Path $Runtime 'postgres\lib\postgresql')) |
      Where-Object { Test-Path -LiteralPath (Split-Path -Parent $_) }

    foreach ($dir in $extensionDirs) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Get-ChildItem -LiteralPath (Split-Path -Parent $control) -File | Where-Object { $_.Name -like 'vector*' } |
        ForEach-Object { Copy-OneFile $_.FullName (Join-Path $dir $_.Name) }
    }
    foreach ($dir in $libraryDirs) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Copy-OneFile $library (Join-Path $dir 'vector.dll')
    }
    Set-Content -LiteralPath (Join-Path $Runtime 'postgres\IMMICH4WIN-PGVECTOR') -Value "pgvector $vectorVersion`nPostgreSQL $pgMajor" -Encoding ASCII
    Write-Detail "installed for PostgreSQL $pgMajor"
  }
} catch {
  Add-Failure 'pgvector' $_.Exception.Message
  Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '    Immich needs the vector extension; without it the database cannot be created.' -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- Redis

Write-Step "Redis $($Toolchain.redis.version)"

$redisAsset = $Toolchain.redis.asset -replace '\{version\}', $Toolchain.redis.version
$redisUrl = "https://github.com/$($Toolchain.redis.repository)/releases/download/$($Toolchain.redis.version)/$redisAsset"
$redisArchive = Join-Path $Cache $redisAsset
$redisExe = Join-Path $Runtime 'redis\redis-server.exe'

try {
  if ((Test-Path -LiteralPath $redisExe) -and -not $Force) {
    Write-Detail 'Redis is already installed'
  } else {
    Invoke-Download -Url $redisUrl -Destination $redisArchive -Label $redisAsset | Out-Null
    $unpacked = Expand-ArchiveTo -Archive $redisArchive -Destination (Join-Path $Cache 'redis-unpacked')
    $server = Find-FirstFile -Root $unpacked -Name 'redis-server.exe'
    if (-not $server) { throw 'the package has no redis-server.exe' }
    Install-Tree -Source (Split-Path -Parent $server) -Destination (Join-Path $Runtime 'redis')
    Write-Detail 'installed'
  }
} catch {
  Add-Failure 'redis' $_.Exception.Message
  Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

# ---------------------------------------------------------------- FFmpeg

Write-Step 'FFmpeg (thumbnails and video transcoding)'

$ffmpegExe = Join-Path $Runtime 'ffmpeg\bin\ffmpeg.exe'
try {
  if ((Test-Path -LiteralPath $ffmpegExe) -and -not $Force) {
    Write-Detail 'FFmpeg is already installed'
  } else {
    # newest numbered build first; master-latest is the fallback when GitHub returns no assets
    $asset = $Toolchain.ffmpeg.fallbackAsset
    $tag = 'latest'
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$($Toolchain.ffmpeg.repository)/releases/latest" -UseBasicParsing -TimeoutSec 60
      $tag = $release.tag_name
      $match = $release.assets | Where-Object { $_.name -match $Toolchain.ffmpeg.assetPattern } | Select-Object -First 1
      if ($match) { $asset = $match.name }
    } catch {
      Write-Skip "could not read the FFmpeg release list, trying $asset"
    }

    $url = "https://github.com/$($Toolchain.ffmpeg.repository)/releases/download/$tag/$asset"
    $archive = Join-Path $Cache $asset
    Invoke-Download -Url $url -Destination $archive -Label $asset | Out-Null
    $unpacked = Expand-ArchiveTo -Archive $archive -Destination (Join-Path $Cache 'ffmpeg-unpacked')
    $ffmpeg = Find-FirstFile -Root $unpacked -Name 'ffmpeg.exe'
    $ffprobe = Find-FirstFile -Root $unpacked -Name 'ffprobe.exe'
    if (-not $ffmpeg -or -not $ffprobe) { throw 'the package has no ffmpeg.exe and ffprobe.exe' }
    Copy-OneFile $ffmpeg (Join-Path $Runtime 'ffmpeg\bin\ffmpeg.exe')
    Copy-OneFile $ffprobe (Join-Path $Runtime 'ffmpeg\bin\ffprobe.exe')
    $license = Find-FirstFile -Root $unpacked -Name 'LICENSE.txt'
    if ($license) { Copy-OneFile $license (Join-Path $Runtime 'ffmpeg\LICENSE.txt') }
    Write-Detail "installed ($tag)"
  }
} catch {
  Add-Failure 'ffmpeg' $_.Exception.Message
  Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

# ---------------------------------------------------------------- ExifTool

Write-Step "ExifTool $($Toolchain.exiftool.version)"

$exiftoolExe = Join-Path $Runtime 'exiftool\exiftool.exe'
try {
  if ((Test-Path -LiteralPath $exiftoolExe) -and -not $Force) {
    Write-Detail 'ExifTool is already installed'
  } else {
    $asset = "exiftool-$($Toolchain.exiftool.version)_64.zip"
    $url = $Toolchain.exiftool.url -replace '\{version\}', $Toolchain.exiftool.version
    $archive = Join-Path $Cache $asset
    Invoke-Download -Url $url -Destination $archive -Label $asset | Out-Null
    $unpacked = Expand-ArchiveTo -Archive $archive -Destination (Join-Path $Cache 'exiftool-unpacked')
    # the zip ships "exiftool(-k).exe", which is renamed the moment it is copied
    $executable = Get-ChildItem -LiteralPath $unpacked -Recurse -File -Filter 'exiftool*.exe' -Depth 3 |
      Select-Object -First 1
    if (-not $executable) { throw 'the package has no exiftool executable' }
    Copy-OneFile $executable.FullName (Join-Path $Runtime 'exiftool\exiftool.exe')
    Get-ChildItem -LiteralPath $executable.Directory -File | Where-Object { $_.Extension -ne '.exe' } |
      ForEach-Object { Copy-OneFile $_.FullName (Join-Path $Runtime "exiftool\$($_.Name)") }
    $files = Join-Path $executable.Directory 'exiftool_files'
    if (Test-Path -LiteralPath $files) {
      Install-Tree -Source $files -Destination (Join-Path $Runtime 'exiftool\exiftool_files')
    }
    Write-Detail 'installed'
  }
} catch {
  Add-Failure 'exiftool' $_.Exception.Message
  Write-Host "    FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

# ---------------------------------------------------------------- machine learning

if ($SkipMl) {
  Write-Step 'Machine learning'
  Write-Skip 'requested with -SkipMl (AI search, face recognition and OCR stay off)'
} else {
  $installMl = Join-Path $Root 'scripts\install-ml.ps1'
  if (Test-Path -LiteralPath $installMl) {
    & $installMl -Root $Root -Force:$Force -Retries $Retries
    if (-not $?) {
      Add-Failure 'machine-learning' 'install-ml.ps1 reported an error'
    }
  } else {
    Add-Failure 'machine-learning' 'scripts\install-ml.ps1 is missing from this build'
  }
}

# ---------------------------------------------------------------- geodata

if ($SkipGeodata) {
  Write-Step 'Place names'
  Write-Skip 'requested with -SkipGeodata (reverse geocoding shows coordinates only)'
} else {
  Write-Step 'Place names for reverse geocoding'
  $geodataScript = Join-Path $Root 'scripts\install-geodata.ps1'
  $immichExe = Join-Path $Root 'Immich.exe'
  if (Test-Path -LiteralPath $geodataScript) {
    & $geodataScript -Root $Root
  } elseif (Test-Path -LiteralPath $immichExe) {
    & $immichExe geodata download
    if ($LASTEXITCODE -ne 0) { Write-Skip 'geodata download failed, run "Immich.exe geodata download" later' }
  }
}

# ---------------------------------------------------------------- verify

Write-Step 'Checking the installation'

$exe = Join-Path $Root 'Immich.exe'
if (Test-Path -LiteralPath $exe) {
  & $exe doctor
  Write-Host ''
} else {
  Add-Failure 'launcher' 'Immich.exe is missing; run make-exe.mjs on the build machine'
}

# ---------------------------------------------------------------- optional service

if ($InstallService) {
  Write-Step 'Starting Immich with Windows'
  $serviceScript = Join-Path $Root 'scripts\service.ps1'
  if (Test-Path -LiteralPath $serviceScript) {
    & $serviceScript -Action install
  } else {
    Add-Failure 'service' 'scripts\service.ps1 is missing from this build'
  }
}

# ---------------------------------------------------------------- summary

Write-Step 'Summary'

if ($script:Failures.Count -eq 0) {
  Write-Host '  Immich4Win is ready.' -ForegroundColor Green
  Write-Host ''
  Write-Host '  Start it with Immich.bat, or:' -ForegroundColor Gray
  Write-Host "    $(Join-Path $Root 'Immich.exe') start --detached" -ForegroundColor Gray
  Write-Host '  It opens in the browser at http://localhost:2283 once the first account is created.' -ForegroundColor Gray
  Write-Host ''
  Write-Host "  Your photos and database live in: $env:LOCALAPPDATA\Immich4Win" -ForegroundColor Gray
  exit 0
}

Write-Host '  Setup finished with problems:' -ForegroundColor Yellow
foreach ($failure in $script:Failures) {
  Write-Host "    - $failure" -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  Fix the message above and run this script again; finished steps are kept.' -ForegroundColor Gray
Write-Host "  Details: $(Join-Path $Root 'Immich.exe') doctor" -ForegroundColor Gray
exit 1
