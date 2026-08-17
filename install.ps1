param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $InstallArguments
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeVersion = if ($env:JAMES_NODE_BOOTSTRAP_VERSION) { $env:JAMES_NODE_BOOTSTRAP_VERSION } else { '22.23.2' }
$InstallHome = if ($env:ACHONG_INSTALL_HOME) { $env:ACHONG_INSTALL_HOME } elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$RuntimeRoot = Join-Path $InstallHome '.james-runtimes'

function Test-NodeRuntime([string] $Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
  & $Candidate -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))process.exit(1)" *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  & $Candidate --input-type=module -e "await import('node:sqlite')" *> $null
  return $LASTEXITCODE -eq 0
}

$Node = $null
$PathNode = Get-Command node.exe -ErrorAction SilentlyContinue
$Candidates = @(
  $(if ($PathNode) { $PathNode.Source }),
  (Join-Path $RuntimeRoot "node-v$NodeVersion\node.exe")
) | Where-Object { $_ }
foreach ($Candidate in $Candidates) {
  if (Test-NodeRuntime $Candidate) {
    $Node = $Candidate
    break
  }
}

if (-not $Node) {
  $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($Architecture -eq 'x64') { $NodeArch = 'x64' }
  elseif ($Architecture -eq 'arm64') { $NodeArch = 'arm64' }
  else { throw "INSTALL_ERROR Unsupported CPU architecture: $Architecture" }

  $FileName = "node-v$NodeVersion-win-$NodeArch.zip"
  $DistUrl = "https://nodejs.org/dist/v$NodeVersion"
  $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("james-node-bootstrap-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
  try {
    $ManifestPath = Join-Path $TempRoot 'SHASUMS256.txt'
    $ArchivePath = Join-Path $TempRoot $FileName
    Invoke-WebRequest -UseBasicParsing -Uri "$DistUrl/SHASUMS256.txt" -OutFile $ManifestPath
    Invoke-WebRequest -UseBasicParsing -Uri "$DistUrl/$FileName" -OutFile $ArchivePath
    $ManifestLine = Get-Content -LiteralPath $ManifestPath | Where-Object { $_ -match "^([a-f0-9]{64})\s+$([regex]::Escape($FileName))$" } | Select-Object -First 1
    if (-not $ManifestLine) { throw 'INSTALL_ERROR Node checksum is missing from the official manifest' }
    $Expected = ($ManifestLine -split '\s+')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw 'INSTALL_ERROR Portable Node checksum mismatch' }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TempRoot -Force
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    $FinalRoot = Join-Path $RuntimeRoot "node-v$NodeVersion"
    $StagedRoot = "$FinalRoot.new"
    Remove-Item -LiteralPath $StagedRoot -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath (Join-Path $TempRoot "node-v$NodeVersion-win-$NodeArch") -Destination $StagedRoot
    Remove-Item -LiteralPath $FinalRoot -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $StagedRoot -Destination $FinalRoot
    $Node = Join-Path $FinalRoot 'node.exe'
  } finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-NodeRuntime $Node)) { throw 'INSTALL_ERROR Downloaded Node runtime failed its capability check' }
}

$env:Path = "$(Split-Path -Parent $Node);$env:Path"
& $Node (Join-Path $ScriptDir 'install.mjs') @InstallArguments
exit $LASTEXITCODE
