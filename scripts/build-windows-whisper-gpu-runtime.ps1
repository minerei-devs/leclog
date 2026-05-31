param(
  [string]$WhisperCppTag = "v1.8.4",
  [string]$OutputDir = "output/windows-runtime-artifacts",
  [string]$WorkDir = "",
  [string]$ReleaseTag = "",
  [string]$Repository = ""
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found on PATH."
  }
}

Require-Command git
Require-Command cmake

if ([string]::IsNullOrWhiteSpace($env:VULKAN_SDK)) {
  throw "VULKAN_SDK is not set. Install the LunarG Vulkan SDK and run this script from a shell where VULKAN_SDK is available."
}

$glslc = Join-Path $env:VULKAN_SDK "Bin\glslc.exe"
if (-not (Test-Path $glslc)) {
  throw "glslc.exe was not found at $glslc."
}

$targetTriple = "x86_64-pc-windows-msvc"
$resolvedOutputDir = Resolve-Path -LiteralPath "." | ForEach-Object {
  Join-Path $_.Path $OutputDir
}
New-Item -ItemType Directory -Force $resolvedOutputDir | Out-Null

if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $WorkDir = Join-Path $env:TEMP "leclog-whisper-gpu-runtime"
}

$whisperSourceDir = Join-Path $WorkDir "whisper.cpp"
$buildDir = Join-Path $WorkDir "build-gpu"

Remove-Item -Recurse -Force $whisperSourceDir, $buildDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $WorkDir | Out-Null

git clone `
  --depth 1 `
  --branch $WhisperCppTag `
  https://github.com/ggml-org/whisper.cpp.git `
  $whisperSourceDir

cmake `
  -S $whisperSourceDir `
  -B $buildDir `
  -DCMAKE_BUILD_TYPE=Release `
  -DBUILD_SHARED_LIBS=OFF `
  -DGGML_NATIVE=OFF `
  -DGGML_SSE42=OFF `
  -DGGML_AVX=OFF `
  -DGGML_AVX2=OFF `
  -DGGML_BMI2=OFF `
  -DGGML_AVX_VNNI=OFF `
  -DGGML_AVX512=OFF `
  -DGGML_VULKAN=ON `
  -DCMAKE_PREFIX_PATH="$env:VULKAN_SDK" `
  -DWHISPER_BUILD_TESTS=OFF `
  -DWHISPER_BUILD_SERVER=OFF

cmake `
  --build $buildDir `
  --config Release `
  --target whisper-cli `
  --parallel $env:NUMBER_OF_PROCESSORS

$whisperExe = Get-ChildItem -Path $buildDir -Recurse -Filter "whisper-cli.exe" |
  Select-Object -First 1
if (-not $whisperExe) {
  throw "whisper-cli.exe was not found after building the Vulkan whisper.cpp runtime."
}

$runtimeAsset = Join-Path $resolvedOutputDir "whisper-cli-gpu-$targetTriple.exe"
Copy-Item $whisperExe.FullName $runtimeAsset

$hash = (Get-FileHash -Algorithm SHA256 $runtimeAsset).Hash.ToLowerInvariant()
$checksumPath = "$runtimeAsset.sha256"
"$hash  whisper-cli-gpu-$targetTriple.exe" |
  Set-Content -NoNewline -Path $checksumPath

Write-Host "Built $runtimeAsset"
Write-Host "Wrote $checksumPath"

if (-not [string]::IsNullOrWhiteSpace($ReleaseTag)) {
  Require-Command gh

  $repoArgs = @()
  if (-not [string]::IsNullOrWhiteSpace($Repository)) {
    $repoArgs = @("--repo", $Repository)
  }

  $uploadArgs = @("release", "upload", $ReleaseTag, $runtimeAsset, $checksumPath) +
    $repoArgs +
    @("--clobber")
  gh @uploadArgs
}
