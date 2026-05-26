# Leclog

Minimal Tauri 2 desktop MVP for local-first lecture sessions.

## Stack

- Tauri 2
- React
- TypeScript
- Vite
- Rust command backend
- JSON-file session persistence
- Tauri Store plugin for lightweight recent state

## Features

- Session list page
- Recording page
- Start, pause, resume, and stop controls
- Local microphone or macOS system-audio capture
- Local transcript generation after stop using `whisper.cpp`
- Session detail page
- Session-level resource manager plus a Settings sheet for app resources, models, storage, and background tasks
- Observable model downloads and transcription jobs with progress and cancellation
- Processing quality presets, chunked transcription, and configurable Whisper thread count
- Local persistence without a database

## Run

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Make sure your Rust toolchain is at least `1.77.2` because the Tauri Store plugin requires it.

3. Release builds bundle `whisper-cli`; for local development, either add the `whisper-cli-<target-triple>` sidecar under `src-tauri/binaries/`, provide a downloadable runtime asset, or install the Homebrew fallback. Models are downloaded automatically on first transcription when missing, or you can override paths with:

   - `LECLOG_WHISPER_PATH`
   - `LECLOG_WHISPER_RUNTIME_URL`
   - `LECLOG_WHISPER_RUNTIME_SHA256`
   - `LECLOG_WHISPER_MODEL_PATH`
   - `LECLOG_WHISPER_LANGUAGE`
   - `LECLOG_WHISPER_PROMPT`

   Example on macOS:

   ```bash
   brew install whisper-cpp
   ```

   Leclog defaults to Whisper language auto-detection. For Japanese lectures,
   these settings usually help:

   ```bash
   export LECLOG_WHISPER_LANGUAGE=ja
   export LECLOG_WHISPER_PROMPT='授業 講義 先生 学生 発表'
   ```

4. Start the app:

   ```bash
   pnpm tauri dev
   ```

## Runtime health

The app now exposes runtime checks in the Settings sheet:

- app local data directory is writable
- `ffmpeg` can be resolved from the bundled sidecar, `LECLOG_FFMPEG_PATH`, or `PATH`
- `whisper-cli` can be resolved from `LECLOG_WHISPER_PATH`, Homebrew paths, or `PATH`
- at least one local Whisper model is available
- interrupted `processing` sessions and partial model downloads are visible

Release builds include `whisper-cli`. If it is missing in a development build, recording and imports still create local session files, and the final transcription task tries to download an app-managed runtime before transcribing. If no model is installed, the same task automatically downloads the recommended app-managed model.

## Runtime packaging strategy

The app should own as much of the runtime as is practical:

- `ffmpeg`: bundled as a Tauri sidecar for macOS Apple Silicon releases.
- `whisper-cli`: bundled as a Tauri sidecar in release builds; app-managed download, Homebrew, and `PATH` remain development/fallback paths.
- Whisper models: downloaded into the local app data directory on first transcription when none is installed, keeping the installer small while avoiding manual setup.

First-run guidance appears on the New Session screen when a required runtime piece is missing. The same checks are always available under Settings → Overview.

Settings → Overview also includes a startup update-check preference. When enabled, Leclog quietly checks the GitHub Releases updater channel on launch and only shows an in-app badge when a newer version is available.

## Resources and processing

The session detail view manages per-session resources. The Settings sheet manages app-level resources under the app local data directory:

- session folders and captured audio segments
- normalized audio and transcript artifacts
- app-managed Whisper models and partial downloads
- current background tasks
- failed task command summaries and stderr excerpts, with revealable logs under app data

Deletion is restricted to managed app resources. Imported source files outside the app data directory are never deleted.

Processing settings are available from Settings:

- `Fast`: smaller model preference and shorter chunks
- `Balanced`: default preset for stable local transcription
- `Accurate`: larger model preference and wider overlap
- `Custom`: manual chunk length, overlap, thread count, and refresh interval

## Release

This repository is set up to build and publish a GitHub Release with GitHub Actions.

Current scope:

- macOS Apple Silicon (`aarch64-apple-darwin`)
- Tauri app bundles: `.app` and `.dmg`
- Tauri updater artifacts: `latest.json` plus signed update archives
- GitHub Release assets uploaded automatically by `.github/workflows/release.yml`
- Signed and notarized macOS releases only
- In-app update checks from Settings use the latest GitHub Release channel

Required GitHub Secrets:

- `APPLE_CERTIFICATE`: base64-encoded `Developer ID Application` `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the `.p12`
- `APPLE_SIGNING_IDENTITY`: exact signing identity name from `security find-identity -v -p codesigning`
- `APPLE_API_KEY`: App Store Connect API Key ID
- `APPLE_API_ISSUER`: App Store Connect API Issuer ID
- `APPLE_API_KEY_P8`: contents of the downloaded `AuthKey_<KEYID>.p8`
- `TAURI_SIGNING_PRIVATE_KEY`: private updater signing key generated by `pnpm tauri signer generate`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional updater key password; leave unset for an unencrypted key

The release workflow now fails fast if:

- the tag version does not match `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
- any required Apple signing, notarization, or updater signing secret is missing

Release flow:

1. Keep the app version aligned in:

   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

2. Commit and push the version change.

3. Create and push a tag that matches the version:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

4. GitHub Actions will build the signed and notarized macOS package, create updater artifacts, and publish the GitHub Release automatically.

You can also run the workflow manually from the GitHub Actions page with `workflow_dispatch`.

If you later want Intel macOS, Windows, or Linux release artifacts, add the matching `ffmpeg-<target-triple>` and `whisper-cli-<target-triple>` binaries under `src-tauri/binaries/` first, then expand the workflow matrix.
