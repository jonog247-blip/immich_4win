<#
   Sets the Windows version resource on Immich.exe.

   A Node SEA is a copy of node.exe, so without this step Explorer lists it with Node's own
   description and the Properties dialog shows Node's version. The strings are written into a
   .rc file and compiled with rc.exe, which ships with the Windows SDK.

   Usage:
     powershell -ExecutionPolicy Bypass -File scripts\set-exe-metadata.ps1 -Path .\Immich.exe -Version 3.4.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Version = '1.0.0.0',
  [string]$ProductName = 'Immich4Win',
  [string]$Description = 'Immich photo and video server for Windows',
  [string]$CompanyName = 'Immich4Win contributors',
  [string]$Copyright = 'Immich is licensed under AGPL-3.0. Bundled components keep their own licenses.'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$exe = (Resolve-Path -LiteralPath $Path).Path
Write-Host "  version resource -> $exe"

# A four part file version is required; "3.4.0-rc.0" becomes 3.4.0.0
$numeric = ($Version -split '-')[0]
$parts = @($numeric -split '\.' | ForEach-Object {
  $n = 0
  if ([int]::TryParse($_, [ref]$n) -and $n -ge 0 -and $n -le 65535) { $n } else { 0 }
})
while ($parts.Count -lt 4) { $parts += 0 }
$fileVersion = ($parts[0..3] -join ', ')

function Find-Tool {
  param([string]$Name)

  $onPath = Get-Command $Name -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "$env:ProgramFiles\Windows Kits\10\bin"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($root in $roots) {
    $candidate = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '10.*' } |
      Sort-Object { [version](($_.Name -split '\.')[0..2] -join '.') } -Descending |
      ForEach-Object { Join-Path $_.FullName "x64\$Name.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($candidate) { return $candidate }
  }

  return $null
}

$rc = Find-Tool 'rc'
if (-not $rc) {
  Write-Warning 'rc.exe from the Windows SDK was not found; Immich.exe keeps the Node version resource (it still works).'
  exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("immich4win-rc-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  $rcFile = Join-Path $work 'version.rc'
  $resource = Join-Path $work 'version.res'

  # 0x0409 = English (United States); 0x2b0 = Unicode code page
  $content = @"
#pragma code_page(65001)
1 VERSIONINFO
FILEVERSION     $fileVersion
PRODUCTVERSION  $fileVersion
FILEFLAGSMASK   0x3fL
FILEFLAGS       0x0L
FILEOS          0x40004L
FILETYPE        0x1L
FILESUBTYPE     0x0L
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName",      "$CompanyName"
      VALUE "FileDescription",  "$Description"
      VALUE "FileVersion",      "$Version"
      VALUE "InternalName",     "Immich"
      VALUE "LegalCopyright",   "$Copyright"
      VALUE "OriginalFilename", "Immich.exe"
      VALUE "ProductName",      "$ProductName"
      VALUE "ProductVersion",   "$Version"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"@
  # no BOM: rc.exe reads the pragma above
  [System.IO.File]::WriteAllText($rcFile, $content, (New-Object System.Text.UTF8Encoding($false)))

  & $rc /nologo /fo $resource $rcFile | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "rc.exe exited with $LASTEXITCODE" }

  # BeginUpdateResource/UpdateResource touch only the resource section, so the appended SEA blob
  # and the Node fuse stay where postject put them
  $signature = @'
using System;
using System.Runtime.InteropServices;

public static class ResourcePatcher
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateResource(IntPtr hUpdate, string lpType, string lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

    public static void Apply(string exePath, string resPath, ushort language)
    {
        byte[] data = System.IO.File.ReadAllBytes(resPath);
        if (data.Length < 32) { throw new InvalidOperationException("resource file is too small"); }

        // Walk the .res file: every record is DataSize, HeaderSize, Type, Name, DataVersion,
        // MemoryFlags, LanguageId, Version, Characteristics. The first byte is 0.
        int offset = 1;
        IntPtr handle = BeginUpdateResource(exePath, false);
        if (handle == IntPtr.Zero) { throw new InvalidOperationException("BeginUpdateResource failed: " + Marshal.GetLastWin32Error()); }

        uint expected = BitConverter.ToUInt32(data, 0);
        uint records = 0;
        bool failed = false;
        try
        {
            while (offset + 8 <= data.Length)
            {
                uint dataSize = BitConverter.ToUInt32(data, offset);
                uint headerSize = BitConverter.ToUInt32(data, offset + 4);
                int header = offset + 8;
                uint type = BitConverter.ToUInt32(data, header);
                uint name = BitConverter.ToUInt32(data, header + 4);
                int payload = header + headerSize;
                if (payload + dataSize > (uint)data.Length) { throw new InvalidOperationException("truncated .res file"); }

                byte[] body = new byte[dataSize];
                Array.Copy(data, payload, body, 0, (int)dataSize);

                string typeName = "#" + type;
                string nameName = "#" + name;
                if (!UpdateResource(handle, typeName, nameName, language, body, dataSize))
                {
                    failed = true;
                    throw new InvalidOperationException("UpdateResource failed: " + Marshal.GetLastWin32Error());
                }

                records++;
                offset = payload + (int)dataSize;
                offset += (4 - (offset % 4)) % 4;
            }
        }
        finally
        {
            // fDiscard=true throws the work away when a record could not be written
            if (!EndUpdateResource(handle, failed)) { throw new InvalidOperationException("EndUpdateResource failed: " + Marshal.GetLastWin32Error()); }
        }

        if (records != expected) { throw new InvalidOperationException("expected " + expected + " resources, applied " + records); }
    }
}
'@

  Add-Type -TypeDefinition $signature -Language CSharp
  [ResourcePatcher]::Apply($exe, $resource, [ushort]0x0409) | Out-Null

  $item = Get-Item -LiteralPath $exe
  Write-Host ("  {0} {1} - {2}" -f $item.Name, $item.VersionInfo.FileVersion, $item.VersionInfo.FileDescription)
}
catch {
  Write-Warning "could not set the version resource: $($_.Exception.Message)"
  exit 0
}
finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
