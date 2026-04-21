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
- Local persistence without a database

## Run

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Make sure your Rust toolchain is at least `1.77.2` because the Tauri Store plugin requires it.

3. Install `whisper.cpp` and place a GGML model at `src-tauri/models/ggml-base.bin`, or set:

   - `LECLOG_WHISPER_PATH`
   - `LECLOG_WHISPER_MODEL_PATH`
   - `LECLOG_WHISPER_LANGUAGE`
   - `LECLOG_WHISPER_PROMPT`

   Example on macOS:

   ```bash
   brew install whisper-cpp
   mkdir -p src-tauri/models
   curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o src-tauri/models/ggml-base.bin
   ```

   For Japanese lectures, these settings usually help:

   ```bash
   export LECLOG_WHISPER_LANGUAGE=ja
   export LECLOG_WHISPER_PROMPT='授業 講義 先生 学生 発表'
   ```

4. Start the app:

   ```bash
   pnpm tauri dev
   ```
