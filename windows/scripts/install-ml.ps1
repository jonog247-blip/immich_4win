<#
  Installs the machine learning service: a standalone CPython, the Python packages Immich needs and
  the model definitions.

  The service runs under uvicorn rather than gunicorn, because gunicorn's process model (fork and
  POSIX signals) does not exist on Windows. That switch is in machine-learning/immich_ml/__main__.py.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\install-ml.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-ml.ps1 -Force     reinstall packages
    powershell -ExecutionPolicy Bypass -File scripts\install-ml.ps1 -Cpu       CPU only (default)
#>
[CmdletBinding()]
param(
  [string]$Root,
  [switch]$Force,
  [int]$Retries = 4,
  [string]$PythonVersion = '3.12'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
  $Root = Split-Path -Parent $scriptDir
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$Toolchain = Get-Content -LiteralPath (Join-Path $Root 'toolchain.json') -Raw | ConvertFrom-Json

$Cache = Join-Path $Root '.downloads'
$Runtime = Join-Path $Root 'runtime'
$PythonDir = Join-Path $Runtime 'python'
$MlDir = Join-Path $Runtime 'ml'
$PackagesDir = Join-Path $MlDir 'packages'
$ToolsDir = Join-Path $Runtime 'build-tools'
New-Item -ItemType Directory -Force -Path $Cache, $PythonDir, $MlDir, $PackagesDir, $ToolsDir | Out-Null

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-Detail {
  param([string]$Message, [string]$Color = 'DarkGray')
  Write-Host "    $Message" -ForegroundColor $Color
}

function Invoke-Fetch {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Label = ''
  )

  if (-not $Label) { $Label = Split-Path -Leaf $Destination }
  if ((Test-Path -LiteralPath $Destination) -and -not $Force -and (Get-Item -LiteralPath $Destination).Length -gt 0) {
    Write-Detail "using cached $Label"
    return $Destination
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  $partial = "$Destination.part"
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      Write-Detail "downloading $Label (attempt $attempt of $Retries)"
      $process = Start-Process -FilePath 'curl.exe' -ArgumentList @(
        '-fL', '--retry', '3', '--connect-timeout', '30', '--max-time', '1800', '-o', $partial, $Url
      ) -NoNewWindow -PassThru -Wait
      if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $partial) -and (Get-Item -LiteralPath $partial).Length -gt 0) {
        Move-Item -LiteralPath $partial -Destination $Destination -Force
        Write-Detail "saved $Label"
        return $Destination
      }

      throw "curl exited with $($process.ExitCode)"
    } catch {
      Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
      if ($attempt -eq $Retries) { throw }
      Start-Sleep -Seconds ([math]::Pow(2, $attempt))
    }
  }
}

# ---------------------------------------------------------------- CPython

Write-Step "Python $($Toolchain.python.version)"

$pythonExe = Join-Path $PythonDir 'python.exe'

if ((Test-Path -LiteralPath $pythonExe) -and -not $Force) {
  $existing = & $pythonExe -c "import sys; print('.'.join(map(str, sys.version_info[:2])))" 2>$null
  Write-Detail "already installed ($existing)"
} else {
  $asset = $Toolchain.python.asset -replace '\{version\}', $Toolchain.python.version -replace '\{tag\}', $Toolchain.python.tag
  $url = "https://github.com/astral-sh/python-build-standalone/releases/download/$($Toolchain.python.tag)/$asset"
  $archive = Join-Path $Cache $asset
  Invoke-Fetch -Url $url -Destination $archive -Label $asset | Out-Null

  $unpacked = Join-Path $Cache 'python-unpacked'
  if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
  # install_only archives contain a single top level "python" folder
  & tar.exe -xzf $archive -C $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'tar.exe could not unpack the Python archive' }

  $pythonHome = Get-ChildItem -LiteralPath $unpacked -Recurse -Directory -Depth 2 |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'python.exe') } |
    Select-Object -First 1
  if (-not $pythonHome) { throw 'the Python archive has no python.exe' }

  # the build is relocatable, so copying the folder is the whole installation
  if (Test-Path -LiteralPath $PythonDir) { Remove-Item -LiteralPath $PythonDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $PythonDir | Out-Null
  & robocopy.exe $pythonHome.FullName $PythonDir /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }

  $version = & $pythonExe -c "import sys; print(sys.version.split()[0])"
  Write-Detail "installed Python $version"
}

# The pip inside python-build-standalone is not always present; ensurepip makes it deterministic
$pipCheck = & $pythonExe -c "import ensurepip, sys; sys.exit(0)" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Detail 'ensurepip is unavailable, pip bootstrap skipped'
}

# ---------------------------------------------------------------- packages

Write-Step 'Python packages (onnxruntime, fastapi, pillow, opencv, tokenizers)'

# The dependency list is read from the machine learning project so it cannot drift from what the
# service imports
$pyproject = Get-Content -LiteralPath (Join-Path $MlDir 'pyproject.toml') -Raw
$dependenciesBlock = [regex]::Match($pyproject, '(?s)dependencies\s*=\s*\[(.*?)\]').Groups[1].Value
$requirements = @()
foreach ($line in ($dependenciesBlock -split "`n")) {
  $clean = ($line -replace '#.*$', '').Trim().TrimEnd(',').Trim()
  $clean = $clean -replace '^"(.*)"$', '$1'
  if (-not $clean) { continue }
  # gunicorn is POSIX only and immich-model is vendored into the packages folder
  if ($clean -like 'gunicorn*' -or $clean -like 'immich-model*') { continue }
  $requirements += $clean
}
# onnxruntime is the inference engine; the project pulls a build for the host OS by default
$requirements += 'onnxruntime>=1.23.2,<2'

if ((Test-Path -LiteralPath (Join-Path $PackagesDir 'uvicorn')) -and -not $Force) {
  Write-Detail 'packages are already installed'
} else {
  Write-Detail "$($requirements.Count) requirements"

  # uv is used when available because it resolves the whole tree in seconds and has a static
  # Windows build; pip is the fallback
  $uvExe = Join-Path $ToolsDir 'uv.exe'
  if (-not (Test-Path -LiteralPath $uvExe)) {
    try {
      $uvAsset = $Toolchain.uv.asset
      $uvUrl = "https://github.com/$($Toolchain.uv.repository)/releases/download/$($Toolchain.uv.tag)/$uvAsset"
      $uvArchive = Join-Path $Cache $uvAsset
      Invoke-Fetch -Url $uvUrl -Destination $uvArchive -Label $uvAsset | Out-Null
      $uvUnpacked = Join-Path $Cache 'uv-unpacked'
      if (Test-Path -LiteralPath $uvUnpacked) { Remove-Item -LiteralPath $uvUnpacked -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $uvUnpacked | Out-Null
      & tar.exe -xf $uvArchive -C $uvUnpacked
      $uvFound = Get-ChildItem -LiteralPath $uvUnpacked -Recurse -File -Filter 'uv.exe' | Select-Object -First 1
      if ($uvFound) {
        Copy-Item -LiteralPath $uvFound.FullName -Destination $uvExe -Force
        Write-Detail "uv $($Toolchain.uv.version) installed"
      }
    } catch {
      Write-Detail "uv was not installed ($($_.Exception.Message)); falling back to pip" 'DarkYellow'
    }
  }

  if (Test-Path -LiteralPath (Join-Path $PackagesDir 'uvicorn')) {
    Remove-Item -LiteralPath $PackagesDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $PackagesDir | Out-Null

  if (Test-Path -LiteralPath $uvExe) {
    # --target keeps the packages beside the service instead of inside the interpreter, so the
    # layout is the same on every machine and nothing is written outside this folder
    & $uvExe pip install --target $PackagesDir --no-cache --link-mode copy @requirements
    if ($LASTEXITCODE -ne 0) { throw "uv exited with $LASTEXITCODE" }
  } else {
    & $pythonExe -m pip install --upgrade pip --quiet --disable-pip-version-check 2>&1 | Out-Null
    & $pythonExe -m pip install --target $PackagesDir --no-cache-dir --disable-pip-version-check @requirements
    if ($LASTEXITCODE -ne 0) { throw "pip exited with $LASTEXITCODE" }
  }

  Write-Detail 'packages installed'
}

# ---------------------------------------------------------------- model definitions

Write-Step 'AI model definitions'

$modelPackage = Join-Path $PackagesDir 'immich_model'
if ((Test-Path -LiteralPath $modelPackage) -and -not $Force) {
  Write-Detail 'already present'
} else {
  $lock = Join-Path $MlDir 'uv.lock'
  $revision = 'main'
  if (Test-Path -LiteralPath $lock) {
    $match = [regex]::Match((Get-Content -LiteralPath $lock -Raw), 'ml-models\.git\?rev=([0-9a-f]{40})')
    if ($match.Success) { $revision = $match.Groups[1].Value }
  }

  $archive = Join-Path $Cache "ml-models-$revision.tar.gz"
  $url = "https://codeload.github.com/immich-app/ml-models/tar.gz/$revision"
  Invoke-Fetch -Url $url -Destination $archive -Label "ml-models $($revision.Substring(0, [math]::Min(8, $revision.Length)))" | Out-Null

  $unpacked = Join-Path $Cache 'ml-models-unpacked'
  if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
  & tar.exe -xzf $archive -C $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'tar.exe could not unpack the model definitions' }

  # resolved from source rather than with pip: the pinned package depends on the export extra,
  # which would pull in torch
  $found = Get-ChildItem -LiteralPath $unpacked -Recurse -Directory -Depth 4 |
    Where-Object { $_.Name -eq 'immich_model' -and (Test-Path -LiteralPath (Join-Path $_.FullName '__init__.py')) } |
    Select-Object -First 1
  if (-not $found) { throw 'the ml-models archive has no immich_model package' }

  if (Test-Path -LiteralPath $modelPackage) { Remove-Item -LiteralPath $modelPackage -Recurse -Force }
  & robocopy.exe $found.FullName $modelPackage /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }
  Write-Detail "installed from revision $($revision.Substring(0, [math]::Min(8, $revision.Length)))"
}

# ---------------------------------------------------------------- verify

Write-Step 'Checking the machine learning service'

$env:PYTHONPATH = "$PackagesDir;$MlDir"
Push-Location $MlDir
try {
  $probe = @"
import importlib, sys
missing = []
for name in ('uvicorn', 'fastapi', 'onnxruntime', 'PIL', 'cv2', 'tokenizers', 'immich_model', 'immich_ml'):
    try:
        importlib.import_module(name)
    except Exception as error:
        missing.append(name + ' (' + type(error).__name__ + ')')
print('OK' if not missing else 'MISSING: ' + ', '.join(missing))
"@
  $probeFile = Join-Path $env:TEMP "immich4win-ml-probe.py"
  Set-Content -LiteralPath $probeFile -Value $probe -Encoding UTF8

  # 2>&1 so a failed import shows its traceback instead of vanishing into a redirect
  $checks = & $pythonExe $probeFile 2>&1
  Write-Detail ($checks | Select-Object -Last 1)

  if (($checks -join "`n") -match 'MISSING') {
    Write-Host ''
    Write-Host '  The machine learning service is incomplete; AI features stay off.' -ForegroundColor Yellow
    Write-Host '  Re-run with -Force, or start Immich with -SkipMl by disabling machine learning in' -ForegroundColor Yellow
    Write-Host '  the admin settings.' -ForegroundColor Yellow
    exit 1
  }
} finally {
  Pop-Location
}

# Models are downloaded on first use and cached here; the folder is created now so the first
# request does not need to create it inside Program Files
$modelCache = Join-Path $Root 'data\model-cache'
New-Item -ItemType Directory -Force -Path $modelCache | Out-Null

Write-Host ''
Write-Host '  Machine learning is ready. The models download on first use.' -ForegroundColor Green
exit 0
