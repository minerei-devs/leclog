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
- Mock live transcript stream that appends a segment every 2 seconds
- Session detail page
- Local persistence without a database

## Run

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Make sure your Rust toolchain is at least `1.77.2` because the Tauri Store plugin requires it.

3. Start the app:

   ```bash
   pnpm tauri dev
   ```
