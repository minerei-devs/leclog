use std::{
    env,
    fs,
    fs::OpenOptions,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::models::{LectureSession, SessionStatus, TranscriptSegment};

const SESSIONS_FILE_NAME: &str = "sessions.json";
const SESSIONS_DIR_NAME: &str = "sessions";
const SESSION_METADATA_FILE_NAME: &str = "session.json";
const CONCAT_INPUTS_FILE_NAME: &str = "concat-inputs.txt";
const NORMALIZED_AUDIO_FILE_NAME: &str = "normalized.wav";
const PROCESSED_TRANSCRIPT_FILE_NAME: &str = "transcript.txt";
const TRANSCRIPT_JSON_FILE_NAME: &str = "transcript.json";
const LIVE_PREVIEW_AUDIO_FILE_NAME: &str = "live-preview.wav";
const LIVE_TRANSCRIPT_JSON_FILE_NAME: &str = "live-transcript.json";
const WAV_HEADER_LEN: u64 = 44;
const DEFAULT_WHISPER_MODEL_FILE_NAMES: [&str; 8] = [
    "ggml-large-v3-turbo.bin",
    "ggml-small.bin",
    "ggml-base.bin",
    "ggml-tiny.bin",
    "ggml-base.en.bin",
    "ggml-small.en.bin",
    "ggml-tiny.en.bin",
    "ggml-large-v3-turbo-q5_0.bin",
];

fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("The sessions path must have a parent directory.")?;
    fs::create_dir_all(parent).context("Failed to create the application data directory.")?;
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf> {
    app
        .path()
        .app_local_data_dir()
        .context("Failed to resolve the local app data directory.")
}

pub fn sessions_file_path(app: &AppHandle) -> Result<PathBuf> {
    let base_dir = app_data_dir(app)?;

    Ok(base_dir.join(SESSIONS_FILE_NAME))
}

fn sessions_root_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(SESSIONS_DIR_NAME))
}

pub fn session_dir_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(sessions_root_dir(app)?.join(session_id))
}

fn session_metadata_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?.join(SESSION_METADATA_FILE_NAME))
}

fn processed_transcript_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(PROCESSED_TRANSCRIPT_FILE_NAME))
}

fn live_preview_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_PREVIEW_AUDIO_FILE_NAME))
}

fn normalized_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(NORMALIZED_AUDIO_FILE_NAME))
}

fn transcript_json_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(TRANSCRIPT_JSON_FILE_NAME))
}

fn live_transcript_json_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_TRANSCRIPT_JSON_FILE_NAME))
}

fn concat_inputs_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(CONCAT_INPUTS_FILE_NAME))
}

pub fn ensure_session_paths(app: &AppHandle, session: &mut LectureSession) -> Result<bool> {
    let session_dir = session_dir_path(app, &session.id)?;
    let normalized_audio = normalized_audio_path(app, &session.id)?;
    let processed_path = processed_transcript_path(app, &session.id)?;
    let live_preview_audio = live_preview_audio_path(app, &session.id)?;

    fs::create_dir_all(session_dir.join("audio"))
        .context("Failed to create the session audio directory.")?;
    fs::create_dir_all(session_dir.join("processed"))
        .context("Failed to create the session processed directory.")?;

    let mut changed = false;

    let session_dir_value = session_dir.display().to_string();
    if session.session_dir.as_deref() != Some(session_dir_value.as_str()) {
        session.session_dir = Some(session_dir_value);
        changed = true;
    }

    let processed_value = processed_path.display().to_string();
    if session.processed_transcript_path.as_deref() != Some(processed_value.as_str()) {
        session.processed_transcript_path = Some(processed_value);
        changed = true;
    }

    let normalized_audio_value = normalized_audio.display().to_string();
    if session.normalized_audio_path.as_deref() != Some(normalized_audio_value.as_str()) {
        session.normalized_audio_path = Some(normalized_audio_value);
        changed = true;
    }

    let live_preview_audio_value = live_preview_audio.display().to_string();
    if session.live_preview_audio_path.as_deref() != Some(live_preview_audio_value.as_str()) {
        session.live_preview_audio_path = Some(live_preview_audio_value);
        changed = true;
    }

    Ok(changed)
}

fn quote_concat_path(path: &str) -> String {
    path.replace('\'', "'\\''")
}

fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported-target"
    }
}

fn resolve_ffmpeg_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = env::var("LECLOG_FFMPEG_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    let target_triple = current_target_triple();
    let local_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("ffmpeg-{target_triple}"));
    if local_sidecar.exists() {
        return local_sidecar;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(format!("ffmpeg-{target_triple}")),
            resource_dir
                .join("binaries")
                .join(format!("ffmpeg-{target_triple}")),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from("ffmpeg")
}

fn resolve_whisper_cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = env::var("LECLOG_WHISPER_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    let target_triple = current_target_triple();
    let local_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("whisper-cli-{target_triple}"));
    if local_sidecar.exists() {
        return local_sidecar;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(format!("whisper-cli-{target_triple}")),
            resource_dir
                .join("binaries")
                .join(format!("whisper-cli-{target_triple}")),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    for candidate in [
        PathBuf::from("/opt/homebrew/bin/whisper-cli"),
        PathBuf::from("/usr/local/bin/whisper-cli"),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from("whisper-cli")
}

fn resolve_whisper_model_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("LECLOG_WHISPER_MODEL_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let mut search_dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")];

    if let Ok(data_dir) = app_data_dir(app) {
        search_dirs.push(data_dir.join("models"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        search_dirs.push(resource_dir.join("models"));
        search_dirs.push(resource_dir);
    }

    for dir in search_dirs {
        for file_name in DEFAULT_WHISPER_MODEL_FILE_NAMES {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn run_ffmpeg(app: &AppHandle, args: &[&str]) -> Result<()> {
    let ffmpeg_path = resolve_ffmpeg_path(app);
    let output = Command::new(&ffmpeg_path)
        .args(args)
        .output()
        .with_context(|| format!("Failed to launch ffmpeg at {}.", ffmpeg_path.display()))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("ffmpeg failed: {}", stderr.trim());
}

fn run_whisper_cli(app: &AppHandle, args: &[&str]) -> Result<()> {
    let whisper_cli_path = resolve_whisper_cli_path(app);
    let output = Command::new(&whisper_cli_path)
        .args(args)
        .output()
        .with_context(|| {
            format!(
                "Failed to launch whisper-cli at {}.",
                whisper_cli_path.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("whisper-cli failed: {}", stderr.trim());
}

fn read_offset_ms(segment: &Value, key: &str) -> Option<u64> {
    segment
        .get("offsets")
        .and_then(|offsets| offsets.get(key))
        .and_then(Value::as_u64)
        .or_else(|| segment.get(key).and_then(Value::as_u64))
}

fn parse_transcript_segments_with_finality(
    raw_json: &str,
    is_final: bool,
    max_end_ms: Option<u64>,
) -> Result<Vec<TranscriptSegment>> {
    let payload: Value =
        serde_json::from_str(raw_json).context("Failed to parse the whisper transcript JSON.")?;
    let items = payload
        .get("transcription")
        .and_then(Value::as_array)
        .or_else(|| payload.get("segments").and_then(Value::as_array))
        .context("The whisper transcript JSON did not contain any segments.")?;

    let mut segments = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }

        let start_ms = read_offset_ms(item, "from").unwrap_or(0);
        let end_ms = read_offset_ms(item, "to").unwrap_or(start_ms.saturating_add(1));
        let capped_end_ms = max_end_ms
            .map(|limit| end_ms.min(limit))
            .unwrap_or(end_ms)
            .max(start_ms.saturating_add(1));

        segments.push(TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            start_ms,
            end_ms: capped_end_ms,
            text: text.to_string(),
            is_final,
        });
    }

    if segments.is_empty() {
        anyhow::bail!("whisper.cpp completed, but no transcript text was produced.");
    }

    Ok(segments)
}

pub fn start_audio_segment(
    app: &AppHandle,
    session: &mut LectureSession,
    extension: &str,
    mime_type: &str,
) -> Result<()> {
    ensure_session_paths(app, session)?;

    let segment_index = session.audio_file_paths.len() + 1;
    let segment_path = session_dir_path(app, &session.id)?
        .join("audio")
        .join(format!(
            "segment-{segment_index:03}.{}",
            extension.trim_start_matches('.')
        ));

    ensure_parent_dir(&segment_path)?;
    fs::write(&segment_path, []).context("Failed to initialize the audio segment file.")?;

    let path_value = segment_path.display().to_string();
    session.active_audio_file_path = Some(path_value.clone());
    session.audio_file_paths.push(path_value);
    session.audio_mime_type = Some(mime_type.to_string());

    Ok(())
}

pub fn append_audio_chunk(session: &LectureSession, chunk: &[u8]) -> Result<()> {
    let path = session
        .active_audio_file_path
        .as_ref()
        .map(PathBuf::from)
        .context("There is no active audio segment for this session.")?;
    ensure_parent_dir(&path)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .context("Failed to open the active audio segment file.")?;
    file.write_all(chunk)
        .context("Failed to append the audio chunk to disk.")?;
    Ok(())
}

pub fn finish_audio_segment(session: &mut LectureSession) {
    session.active_audio_file_path = None;
}

pub fn rollback_last_audio_segment(session: &mut LectureSession) -> Result<()> {
    let Some(last_path) = session.audio_file_paths.pop() else {
        session.active_audio_file_path = None;
        return Ok(());
    };

    session.active_audio_file_path = None;
    let path = PathBuf::from(last_path);
    if path.exists() {
        fs::remove_file(path).context("Failed to remove the incomplete capture file.")?;
    }
    Ok(())
}

fn persist_session_snapshot(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let path = session_metadata_path(app, &session.id)?;
    ensure_parent_dir(&path)?;

    let payload =
        serde_json::to_string_pretty(session).context("Failed to serialize session metadata.")?;
    fs::write(path, payload).context("Failed to write session metadata.")?;
    Ok(())
}

pub fn load_sessions(app: &AppHandle) -> Result<Vec<LectureSession>> {
    let path = sessions_file_path(app)?;
    ensure_parent_dir(&path)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path).context("Failed to read sessions.json.")?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let sessions =
        serde_json::from_str::<Vec<LectureSession>>(&raw).context("Failed to parse sessions.json.")?;
    Ok(sessions)
}

pub fn persist_sessions(app: &AppHandle, sessions: &[LectureSession]) -> Result<()> {
    let path = sessions_file_path(app)?;
    ensure_parent_dir(&path)?;

    let payload =
        serde_json::to_string_pretty(sessions).context("Failed to serialize session data.")?;
    fs::write(path, payload).context("Failed to write session data to disk.")?;

    for session in sessions {
        persist_session_snapshot(app, session)?;
    }

    Ok(())
}

pub fn write_processed_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let path = if let Some(path) = &session.processed_transcript_path {
        PathBuf::from(path)
    } else {
        processed_transcript_path(app, &session.id)?
    };
    ensure_parent_dir(&path)?;

    let mut output = String::new();
    output.push_str(&format!("# {}\n\n", session.title));
    output.push_str(&format!("Status: {:?}\n", session.status));
    output.push_str(&format!("Duration: {} ms\n", session.duration_ms));
    output.push_str(&format!("Capture files: {}\n", session.audio_file_paths.len()));
    if let Some(mime_type) = &session.audio_mime_type {
        output.push_str(&format!("Capture MIME type: {mime_type}\n"));
    }
    if let Some(capture_target_label) = &session.capture_target_label {
        output.push_str(&format!("Capture target: {capture_target_label}\n"));
    }
    if let Some(normalized_audio_path) = &session.normalized_audio_path {
        output.push_str(&format!("Normalized audio: {normalized_audio_path}\n"));
    }
    output.push('\n');

    if session.segments.is_empty() {
        output.push_str("No transcript segments were captured for this session.\n");
    } else {
        for segment in &session.segments {
            output.push_str(&format!(
                "[{} - {}] {}\n",
                segment.start_ms, segment.end_ms, segment.text
            ));
        }
    }

    fs::write(path, output).context("Failed to write processed transcript artifact.")?;
    Ok(())
}

fn transcribe_audio_path(
    app: &AppHandle,
    audio_path: &Path,
    transcript_json_path: &Path,
    is_final: bool,
    language: &str,
    prompt: Option<&str>,
    max_end_ms: Option<u64>,
) -> Result<Vec<TranscriptSegment>> {
    if !audio_path.exists() {
        anyhow::bail!("The audio file does not exist: {}", audio_path.display());
    }
    let model_path = resolve_whisper_model_path(app).context(
        "No local Whisper model was found. Set LECLOG_WHISPER_MODEL_PATH or place a ggml model under src-tauri/models or the app local data models directory.",
    )?;

    ensure_parent_dir(&transcript_json_path)?;

    let output_base = transcript_json_path.with_extension("");
    let output_base_str = output_base.to_string_lossy().to_string();
    let audio_path_str = audio_path.to_string_lossy().to_string();
    let model_path_str = model_path.to_string_lossy().to_string();
    let mut args = vec![
        String::from("--language"),
        language.to_string(),
        String::from("--model"),
        model_path_str,
        String::from("--file"),
        audio_path_str,
        String::from("--output-json"),
        String::from("--output-json-full"),
        String::from("--output-file"),
        output_base_str,
        String::from("--no-prints"),
    ];
    if let Some(prompt) = prompt {
        let trimmed_prompt = prompt.trim();
        if !trimmed_prompt.is_empty() {
            args.push(String::from("--prompt"));
            args.push(trimmed_prompt.to_string());
        }
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();

    run_whisper_cli(app, &arg_refs)?;

    let raw_transcript = fs::read(&transcript_json_path).with_context(|| {
        format!(
            "Failed to read the whisper transcript JSON at {}.",
            transcript_json_path.display()
        )
    })?;
    let raw_transcript = String::from_utf8_lossy(&raw_transcript).into_owned();

    parse_transcript_segments_with_finality(&raw_transcript, is_final, max_end_ms)
}

fn resolve_whisper_language() -> String {
    env::var("LECLOG_WHISPER_LANGUAGE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| String::from("auto"))
}

fn resolve_whisper_prompt() -> Option<String> {
    env::var("LECLOG_WHISPER_PROMPT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn wav_duration_ms(path: &Path, sample_rate: u32) -> Result<u64> {
    let file_len = fs::metadata(path)
        .with_context(|| format!("Failed to read WAV metadata at {}.", path.display()))?
        .len();
    if file_len <= WAV_HEADER_LEN {
        return Ok(0);
    }

    let data_bytes = file_len - WAV_HEADER_LEN;
    let bytes_per_second = u64::from(sample_rate) * 2;
    if bytes_per_second == 0 {
        return Ok(0);
    }

    Ok(data_bytes.saturating_mul(1000) / bytes_per_second)
}

pub fn transcribe_normalized_audio(
    app: &AppHandle,
    session: &LectureSession,
) -> Result<Vec<TranscriptSegment>> {
    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio file.")?;
    let transcript_json_path = transcript_json_path(app, &session.id)?;
    let language = resolve_whisper_language();
    let prompt = resolve_whisper_prompt();

    transcribe_audio_path(
        app,
        &normalized_audio_path,
        &transcript_json_path,
        true,
        &language,
        prompt.as_deref(),
        None,
    )
}

pub fn transcribe_live_preview_audio(
    app: &AppHandle,
    session: &LectureSession,
) -> Result<Vec<TranscriptSegment>> {
    let live_preview_audio_path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a live preview audio file.")?;
    if !live_preview_audio_path.exists()
        || fs::metadata(&live_preview_audio_path)
            .map(|metadata| metadata.len() <= WAV_HEADER_LEN)
            .unwrap_or(true)
    {
        return Ok(Vec::new());
    }
    let transcript_json_path = live_transcript_json_path(app, &session.id)?;
    let language = resolve_whisper_language();
    let prompt = resolve_whisper_prompt();
    let sample_rate = session.live_preview_sample_rate.unwrap_or(16_000);
    let max_end_ms = Some(wav_duration_ms(&live_preview_audio_path, sample_rate)?);

    transcribe_audio_path(
        app,
        &live_preview_audio_path,
        &transcript_json_path,
        false,
        &language,
        prompt.as_deref(),
        max_end_ms,
    )
}

pub fn normalize_audio_for_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    if session.audio_file_paths.is_empty() {
        return Ok(());
    }

    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio output path.")?;
    ensure_parent_dir(&normalized_audio_path)?;
    let normalized_audio_str = normalized_audio_path.to_string_lossy().to_string();

    if session.audio_file_paths.len() == 1 {
        run_ffmpeg(
            app,
            &[
                "-y",
                "-i",
                &session.audio_file_paths[0],
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                &normalized_audio_str,
            ],
        )?;
        return Ok(());
    }

    let concat_inputs_path = concat_inputs_path(app, &session.id)?;
    ensure_parent_dir(&concat_inputs_path)?;
    let concat_manifest = session
        .audio_file_paths
        .iter()
        .map(|path| format!("file '{}'", quote_concat_path(path)))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&concat_inputs_path, concat_manifest)
        .context("Failed to write ffmpeg concat manifest.")?;

    let concat_inputs_str = concat_inputs_path.to_string_lossy().to_string();
    run_ffmpeg(
        app,
        &[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            &concat_inputs_str,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            &normalized_audio_str,
        ],
    )?;

    Ok(())
}

pub fn prepare_sessions_on_startup(app: &AppHandle, sessions: &mut [LectureSession]) -> Result<bool> {
    let mut changed = false;

    for session in sessions {
        if ensure_session_paths(app, session)? {
            changed = true;
        }

        if session.status == SessionStatus::Recording {
            session.status = SessionStatus::Paused;
            session.last_resumed_at = None;
            finish_audio_segment(session);
            changed = true;
        }
    }

    Ok(changed)
}

fn write_wav_header(
    file: &mut fs::File,
    sample_rate: u32,
    channels: u16,
    data_bytes_len: u32,
) -> Result<()> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let riff_chunk_size = 36 + data_bytes_len;

    file.seek(SeekFrom::Start(0))
        .context("Failed to seek to the beginning of the WAV file.")?;
    file.write_all(b"RIFF")?;
    file.write_all(&riff_chunk_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes_len.to_le_bytes())?;
    Ok(())
}

pub fn initialize_live_preview_audio(
    app: &AppHandle,
    session: &mut LectureSession,
    sample_rate: u32,
    reset: bool,
) -> Result<bool> {
    ensure_session_paths(app, session)?;

    let preview_path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or(live_preview_audio_path(app, &session.id)?);
    ensure_parent_dir(&preview_path)?;

    let mut changed = false;

    if reset || !preview_path.exists() {
        let mut file = fs::File::create(&preview_path)
            .context("Failed to create the live preview audio file.")?;
        write_wav_header(&mut file, sample_rate, 1, 0)?;
        changed = true;
    }

    let preview_path_value = preview_path.display().to_string();
    if session.live_preview_audio_path.as_deref() != Some(preview_path_value.as_str()) {
        session.live_preview_audio_path = Some(preview_path_value);
        changed = true;
    }

    if session.live_preview_sample_rate != Some(sample_rate) {
        session.live_preview_sample_rate = Some(sample_rate);
        changed = true;
    }

    Ok(changed)
}

pub fn append_live_preview_chunk_to_path(
    path: &Path,
    sample_rate: u32,
    chunk: &[u8],
) -> Result<()> {
    if chunk.is_empty() {
        return Ok(());
    }

    ensure_parent_dir(path)?;
    let exists = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .context("Failed to open the live preview audio file.")?;

    if !exists || file.metadata()?.len() < WAV_HEADER_LEN {
        file.set_len(0)?;
        write_wav_header(&mut file, sample_rate, 1, 0)?;
    }

    file.seek(SeekFrom::End(0))
        .context("Failed to seek to the end of the live preview audio file.")?;
    file.write_all(chunk)
        .context("Failed to append live preview audio.")?;

    let file_len = file
        .metadata()
        .context("Failed to read the live preview audio metadata.")?
        .len();
    let data_len = file_len.saturating_sub(WAV_HEADER_LEN) as u32;
    write_wav_header(&mut file, sample_rate, 1, data_len)?;

    Ok(())
}

pub fn append_live_preview_chunk(session: &LectureSession, chunk: &[u8]) -> Result<()> {
    let path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a live preview audio path.")?;
    let sample_rate = session
        .live_preview_sample_rate
        .context("The session is missing a live preview sample rate.")?;

    append_live_preview_chunk_to_path(&path, sample_rate, chunk)
}

#[cfg(test)]
mod tests {
    use super::parse_transcript_segments_with_finality;

    #[test]
    fn parses_whisper_cpp_json_segments() {
        let raw = r#"{
          "result": { "language": "ja" },
          "transcription": [
            {
              "offsets": { "from": 0, "to": 8500 },
              "text": "こんにちは"
            },
            {
              "offsets": { "from": 8500, "to": 12000 },
              "text": "世界"
            }
          ]
        }"#;

        let segments =
            parse_transcript_segments_with_finality(raw, true, None)
                .expect("segments should parse");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 8500);
        assert_eq!(segments[0].text, "こんにちは");
        assert_eq!(segments[1].start_ms, 8500);
        assert_eq!(segments[1].end_ms, 12000);
        assert_eq!(segments[1].text, "世界");
        assert!(segments.iter().all(|segment| segment.is_final));
    }
}
