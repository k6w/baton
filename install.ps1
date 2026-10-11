# Install Baton on Windows:  irm https://k6w.github.io/baton/install.ps1 | iex
#
#   $env:BATON_VERSION = "0.2.0"     install that version (default: latest release)
#   $env:BATON_INSTALL_DIR = "..."   where baton.exe goes (default: %LOCALAPPDATA%\baton\bin)
#   $env:BATON_REPO = "owner/name"   GitHub repository to download from
#
# Downloads the Windows release for your machine, verifies its SHA-256 against the release's
# SHA256SUMS, puts baton.exe in the install folder and adds that folder to your user PATH.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = if ($env:BATON_REPO) { $env:BATON_REPO } else { "k6w/baton" }
$Dir = if ($env:BATON_INSTALL_DIR) { $env:BATON_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "baton\bin" }
$Version = $env:BATON_VERSION

# x64 build; Windows on Arm runs it through its built-in x64 emulation
$Target = "windows-x64"
$Archive = "baton-$Target.zip"

if (-not $Version) {
  # releases/latest redirects to .../tag/vX.Y.Z: no API call, so no API rate limit
  try {
    $req = [System.Net.WebRequest]::Create("https://github.com/$Repo/releases/latest")
    $req.AllowAutoRedirect = $false
    $resp = $req.GetResponse()
    $Version = ($resp.Headers["Location"] -split "/")[-1]
    $resp.Close()
  } catch {}
  if (-not $Version) {
    $latest = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "baton-install" }
    $Version = $latest.tag_name
  }
}
$Version = $Version.TrimStart("v")
$Base = if ($env:BATON_DOWNLOAD_BASE) { "$env:BATON_DOWNLOAD_BASE/v$Version" } else { "https://github.com/$Repo/releases/download/v$Version" }

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("baton-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading Baton $Version ($Target)..."
  Invoke-WebRequest "$Base/$Archive" -OutFile (Join-Path $Tmp $Archive) -UseBasicParsing
  Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS") -UseBasicParsing

  $line = Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape($Archive))$" } | Select-Object -First 1
  if (-not $line) { throw "$Archive is not listed in SHA256SUMS" }
  $want = ($line -split "\s+")[0].ToLower()
  $got = (Get-FileHash (Join-Path $Tmp $Archive) -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { throw "checksum mismatch for $Archive (expected $want, got $got)" }

  Expand-Archive (Join-Path $Tmp $Archive) -DestinationPath $Tmp -Force
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $Dest = Join-Path $Dir "baton.exe"
  # a running baton.exe can't be overwritten, but it can be moved aside
  if (Test-Path $Dest) {
    Remove-Item "$Dest.old" -Force -ErrorAction SilentlyContinue
    Move-Item $Dest "$Dest.old" -Force
  }
  Copy-Item (Join-Path $Tmp "baton-$Target\baton.exe") $Dest -Force
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed baton $Version -> $Dest"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $Dir)) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";") + ";" + $Dir).TrimStart(";")), "User")
  Write-Host "Added $Dir to your PATH (open a new terminal to use it)."
}
Write-Host ""
Write-Host "Next: cd into a project and run  baton"
Write-Host "      (baton doctor shows which agents it found)"
