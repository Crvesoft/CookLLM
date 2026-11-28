<#
.SYNOPSIS
  Build the standalone Windows x64 NInfer converter bundle (`cookllm-ninfer-converter-win-x64.zip`)
  for hosting in a dedicated GitHub repository Release (e.g. `Crvesoft/cookllm-ninfer-converter`).

.DESCRIPTION
  Downloads:
    1. Official Python 3.11.9 Windows embeddable x64 zip + get-pip.py
    2. CPU-only PyTorch (`torch`), `numpy`, `gguf`, and `safetensors` wheels
    3. `iamwavecut/ninfer-all` (pinned commit `5fe3107796c050d5ab6e7c0e23f0a921958914e3`)
       with `kvmem/kvmem` `backends/patches/ninfer-converter-2026-11-25.patch` applied to `tools/`
    4. `scripts/cookllm_convert.py` from CookLLM

  Outputs in `-OutDir` (default `.\dist-converter`):
    - `cookllm-ninfer-converter-win-x64.zip`
    - `cookllm-ninfer-converter-win-x64.zip.sha256`

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-ninfer-converter-bundle.ps1 -Version "v1.0.0"

.NOTES
  You can also run this script inside a `windows-latest` GitHub Actions workflow in your converter repo
  to automatically publish `cookllm-ninfer-converter-win-x64.zip` + `.sha256` on tag push (`v*`).
#>
param(
  [string]$Version = "v1.0.0",
  [string]$OutDir = ".\dist-converter",
  [string]$PythonVersion = "3.11.9",
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cpu"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$NinferAllCommit = "5fe3107796c050d5ab6e7c0e23f0a921958914e3"
$NinferAllRepo = "https://github.com/iamwavecut/ninfer-all.git"
$KvmemPatchUrl = "https://raw.githubusercontent.com/kvmem/kvmem/master/backends/patches/ninfer-converter-2026-11-25.patch"
$PythonEmbedUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WrapperSrc = Join-Path $ScriptDir "cookllm_convert.py"
if (!(Test-Path $WrapperSrc)) {
  throw "Missing $WrapperSrc"
}

$OutAbs = [System.IO.Path]::GetFullPath($OutDir)
$WorkDir = Join-Path $OutAbs "_work"
$StageDir = Join-Path $WorkDir "bundle"
$PyDir = Join-Path $StageDir "python"
$ToolsDest = Join-Path $StageDir "tools"

if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force -Path $OutAbs, $WorkDir, $StageDir, $PyDir, $ToolsDest | Out-Null

Write-Host "[1/6] Downloading Python $PythonVersion embeddable zip..."
$PyZip = Join-Path $WorkDir "python-embed.zip"
Invoke-WebRequest -Uri $PythonEmbedUrl -OutFile $PyZip
Expand-Archive -Path $PyZip -DestinationPath $PyDir -Force

# Enable site-packages & bundle root imports in embeddable Python
$PthFile = Get-ChildItem -Path $PyDir -Filter "python*._pth" | Select-Object -First 1
if (!$PthFile) { throw "Could not find python*._pth in $PyDir" }
$PthLines = Get-Content $PthFile.FullName | Where-Object { $_ -notmatch "^\s*#\s*import site" }
$PthLines += "Lib\site-packages"
$PthLines += ".."
$PthLines += "import site"
Set-Content -Path $PthFile.FullName -Value $PthLines -Encoding ASCII

$PyExe = Join-Path $PyDir "python.exe"
$GetPip = Join-Path $WorkDir "get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPip

Write-Host "[2/6] Bootstrapping pip and installing torch (CPU), numpy, gguf, safetensors..."
& $PyExe $GetPip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "get-pip failed" }

& $PyExe -m pip install --no-cache-dir --no-warn-script-location --prefer-binary `
  --index-url $TorchIndexUrl --extra-index-url "https://pypi.org/simple" `
  torch numpy gguf safetensors
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# Trim unnecessary heavy files (tests, pip cache, __pycache__, *.pyc) to keep bundle compact
Get-ChildItem -Path $PyDir -Recurse -Include "__pycache__" -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path (Join-Path $PyDir "Lib\site-packages\torch") -Include "test", "include" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[3/6] Fetching iamwavecut/ninfer-all @ $NinferAllCommit..."
$RepoClone = Join-Path $WorkDir "ninfer-all"
git init $RepoClone | Out-Null
Push-Location $RepoClone
try {
  git remote add origin $NinferAllRepo
  git fetch --depth 1 origin $NinferAllCommit
  git checkout FETCH_HEAD

  Write-Host "[4/6] Applying kvmem ninfer-converter patch to tools/..."
  $PatchFile = Join-Path $WorkDir "ninfer-converter.patch"
  Invoke-WebRequest -Uri $KvmemPatchUrl -OutFile $PatchFile
  git apply --include="tools/*" $PatchFile
  if ($LASTEXITCODE -ne 0) { throw "git apply failed on tools/*" }
} finally {
  Pop-Location
}

Write-Host "[5/6] Staging tools/, cookllm_convert.py, and manifest..."
Copy-Item -Recurse -Force (Join-Path $RepoClone "tools\artifact") (Join-Path $ToolsDest "artifact")
Copy-Item -Recurse -Force (Join-Path $RepoClone "tools\convert") (Join-Path $ToolsDest "convert")
Copy-Item -Recurse -Force (Join-Path $RepoClone "tools\chat_templates") (Join-Path $ToolsDest "chat_templates")
$FreqSrcDir = Join-Path $RepoClone "tools\freq_corpus\fixtures\ranking"
if (Test-Path $FreqSrcDir) {
  $FreqDestDir = Join-Path $ToolsDest "freq_corpus\fixtures\ranking"
  New-Item -ItemType Directory -Force -Path $FreqDestDir | Out-Null
  $TrainCounts = Join-Path $FreqSrcDir "ranking.train.counts.i64"
  if (Test-Path $TrainCounts) {
    Copy-Item -Force $TrainCounts (Join-Path $FreqDestDir "ranking.train.counts.i64")
  }
  Get-ChildItem -Path $FreqSrcDir -Filter "*.json" -File | ForEach-Object {
    Copy-Item -Force $_.FullName (Join-Path $FreqDestDir $_.Name)
  }
}
New-Item -ItemType File -Force -Path (Join-Path $ToolsDest "__init__.py") | Out-Null
Copy-Item -Force $WrapperSrc (Join-Path $StageDir "cookllm_convert.py")

# Smoke check imports and CLI with isolated embedded Python
& $PyExe (Join-Path $StageDir "cookllm_convert.py") --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Bundle CLI smoke check failed" }
& $PyExe -I -c "import numpy as np, torch, gguf, safetensors.torch; from tools.artifact.writer import ArtifactWriter; from tools.convert import gguf_blocks, proposal, resources, __main__; recipes = set(gguf_blocks.RECIPES); assert 'qwen3_5_dense_gguf' in recipes, sorted(recipes); assert proposal.DEFAULT_RANKING.is_file(), proposal.DEFAULT_RANKING; assert proposal.DEFAULT_INCLUDE.is_file(), proposal.DEFAULT_INCLUDE; inc = proposal.load_include('auto', proposal.DEFAULT_RANKING); assert len(inc) > 0, inc; counts = np.fromfile(proposal.DEFAULT_RANKING, dtype='<i8', count=248320); assert counts.size == 248320; print('Verified recipes & proposal fixtures:', sorted(recipes), 'include:', len(inc))"
if ($LASTEXITCODE -ne 0) { throw "Bundle import smoke check failed" }

$Manifest = @{
  version       = $Version
  platform      = "windows-x64"
  upstreamRepo  = "iamwavecut/ninfer-all"
  upstreamCommit = $NinferAllCommit
  kvmemPatch    = "ninfer-converter-2026-11-25.patch"
  pythonVersion = $PythonVersion
  builtAt       = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $StageDir "bundle-manifest.json") -Value $Manifest -Encoding UTF8

Write-Host "[6/6] Compressing bundle zip and computing SHA-256..."
$ZipName = "cookllm-ninfer-converter-win-x64.zip"
$ZipPath = Join-Path $OutAbs $ZipName
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal

$Hash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$ShaPath = "$ZipPath.sha256"
Set-Content -Path $ShaPath -Value "$Hash  $ZipName" -Encoding ASCII

Remove-Item -Recurse -Force $WorkDir
Write-Host "Done!"
Write-Host "  Bundle: $ZipPath"
Write-Host "  SHA256: $Hash ($ShaPath)"
