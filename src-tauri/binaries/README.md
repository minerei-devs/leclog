Sidecar binaries in this directory must be named with Tauri's target suffix:

- `ffmpeg-aarch64-apple-darwin`
- `whisper-cli-aarch64-apple-darwin`
- `ffmpeg-x86_64-pc-windows-msvc.exe`
- `whisper-cli-x86_64-pc-windows-msvc.exe`
- `whisper-cli-gpu-x86_64-pc-windows-msvc.exe`

Release builds stage `whisper-cli-<target-triple>` here during GitHub Actions and
temporarily add it to Tauri's `externalBin` list before packaging. GitHub Actions
does not build the Windows GPU runtime because the Vulkan build is slower and more
toolchain-heavy; build it locally with:

```powershell
.\scripts\build-windows-whisper-gpu-runtime.ps1
```

To upload the app-managed GPU runtime to a release without spending Actions time:

```powershell
.\scripts\build-windows-whisper-gpu-runtime.ps1 `
  -ReleaseTag v0.4.1 `
  -Repository minerei-devs/leclog
```

Leclog can download the selected runtime into the app data `runtime/` directory
as a fallback:

- `Auto` prefers `whisper-cli-gpu-<target-triple>` when it exists, then falls
  back to `whisper-cli-<target-triple>`.
- `CPU build` only uses `whisper-cli-<target-triple>`.
- `GPU build` only uses `whisper-cli-gpu-<target-triple>`.

For local development, `LECLOG_WHISPER_CPU_PATH` and `LECLOG_WHISPER_GPU_PATH`
can point at hand-built binaries. `LECLOG_WHISPER_PATH` remains a generic
fallback. The Whisper binary must be self-contained enough for end-user machines;
a Homebrew-linked `whisper-cli` is fine for local development only if its
dependent libraries are also available on the target machine.
