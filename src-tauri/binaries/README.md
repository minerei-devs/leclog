Sidecar binaries in this directory must be named with Tauri's target suffix:

- `ffmpeg-aarch64-apple-darwin`
- `whisper-cli-aarch64-apple-darwin`

Release builds stage `whisper-cli-<target-triple>` here during GitHub Actions and
temporarily add it to Tauri's `externalBin` list before packaging. Leclog can also
download `whisper-cli-<target-triple>` into the app data `runtime/` directory as
a fallback. The Whisper binary must be self-contained enough for end-user
machines; a Homebrew-linked `whisper-cli` is fine for local development only if
its dependent libraries are also available on the target machine.
