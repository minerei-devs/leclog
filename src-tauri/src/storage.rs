use std::{
    env, fs,
    fs::OpenOptions,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Utc;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    models::{
        BackgroundTask, LectureSession, ManagedTranscriptionModel, ModelDownloadStatus,
        ProcessingQualityPreset, ProcessingSettings, SessionExportFormat, SessionExportRequest,
        SessionExportResult, SessionStatus, TaskFailureLog, TranscriptExportLayer,
        TranscriptSegment, TranscriptionModelInfo,
    },
    state::TranscriptionTaskState,
};

const SESSIONS_FILE_NAME: &str = "sessions.json";
const PROCESSING_SETTINGS_FILE_NAME: &str = "processing-settings.json";
const SESSIONS_DIR_NAME: &str = "sessions";
const SESSION_METADATA_FILE_NAME: &str = "session.json";
const CONCAT_INPUTS_FILE_NAME: &str = "concat-inputs.txt";
const NORMALIZED_AUDIO_FILE_NAME: &str = "normalized.wav";
const PROCESSED_TRANSCRIPT_FILE_NAME: &str = "transcript.txt";
const POLISHED_TRANSCRIPT_FILE_NAME: &str = "transcript-polished.txt";
const TRANSCRIPT_JSON_FILE_NAME: &str = "transcript.json";
const LIVE_PREVIEW_AUDIO_FILE_NAME: &str = "live-preview.wav";
const LIVE_TRANSCRIPT_JSON_FILE_NAME: &str = "live-transcript.json";
const LIVE_TRANSCRIPT_WINDOW_AUDIO_FILE_NAME: &str = "live-transcript-window.wav";
const EXPORTS_DIR_NAME: &str = "exports";
const CHUNKS_DIR_NAME: &str = "chunks";
const TASK_FAILURES_DIR_NAME: &str = "task-failures";
const TASK_LOGS_DIR_NAME: &str = "logs/tasks";
const TASK_FAILURE_LOG_FILE_NAME: &str = "latest.json";
const TASK_STDERR_FILE_NAME: &str = "latest.stderr.log";
const TASK_FAILURE_EXCERPT_BYTES: usize = 4 * 1024;
const WAV_HEADER_LEN: u64 = 44;
const LIVE_TRANSCRIPT_WINDOW_MS: u64 = 120_000;
const LIVE_TRANSCRIPT_REFRESH_GRACE_MS: u64 = 2_000;
const LIVE_TRANSCRIPT_WINDOW_SAMPLE_RATE: u32 = 16_000;
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

const MODEL_REPOSITORY_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const WHISPER_RUNTIME_REPOSITORY_BASE_URL: &str =
    "https://github.com/minerei-devs/leclog/releases/latest/download";
const MANAGED_MODEL_CATALOG: [(&str, &str, u64, bool); 4] = [
    ("ggml-base.bin", "Base", 142 * 1024 * 1024, false),
    ("ggml-small.bin", "Small", 466 * 1024 * 1024, true),
    (
        "ggml-large-v3-turbo-q5_0.bin",
        "Large v3 Turbo q5_0",
        547 * 1024 * 1024,
        false,
    ),
    (
        "ggml-large-v3-turbo.bin",
        "Large v3 Turbo",
        1550 * 1024 * 1024,
        false,
    ),
];

fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("The sessions path must have a parent directory.")?;
    fs::create_dir_all(parent).context("Failed to create the application data directory.")?;
    Ok(())
}

fn write_text_if_changed(path: &Path, payload: &str, context: &str) -> Result<()> {
    if fs::read_to_string(path)
        .map(|current| current == payload)
        .unwrap_or(false)
    {
        return Ok(());
    }

    fs::write(path, payload).with_context(|| context.to_string())?;
    Ok(())
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .context("Failed to resolve the local app data directory.")
}

fn sanitize_path_part(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn task_failure_scope(task: &BackgroundTask) -> String {
    if let Some(session_id) = task.session_id.as_deref() {
        return format!("session-{}", sanitize_path_part(session_id));
    }
    if let Some(model_id) = task.model_id.as_deref() {
        return format!("model-{}", sanitize_path_part(model_id));
    }
    format!("task-{}", sanitize_path_part(&task.id))
}

fn task_failure_scope_path(app: &AppHandle, scope: &str) -> Result<PathBuf> {
    Ok(app_data_dir(app)?
        .join(TASK_FAILURES_DIR_NAME)
        .join(format!("{scope}.json")))
}

fn task_log_dir(app: &AppHandle, task_id: &str) -> Result<PathBuf> {
    Ok(app_data_dir(app)?
        .join(TASK_LOGS_DIR_NAME)
        .join(sanitize_path_part(task_id)))
}

fn task_failure_log_path(app: &AppHandle, task_id: &str) -> Result<PathBuf> {
    Ok(task_log_dir(app, task_id)?.join(TASK_FAILURE_LOG_FILE_NAME))
}

fn task_stderr_path(app: &AppHandle, task_id: &str) -> Result<PathBuf> {
    Ok(task_log_dir(app, task_id)?.join(TASK_STDERR_FILE_NAME))
}

fn command_summary(program_path: &Path, args: &[&str]) -> String {
    let mut parts = vec![program_path.display().to_string()];
    parts.extend(args.iter().map(|arg| (*arg).to_string()));
    parts.join(" ")
}

fn read_tail_excerpt(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(path).with_context(|| format!("Failed to read {}.", path.display()))?;
    if bytes.is_empty() {
        return Ok(None);
    }

    let start = bytes.len().saturating_sub(TASK_FAILURE_EXCERPT_BYTES);
    let excerpt = String::from_utf8_lossy(&bytes[start..]).trim().to_string();
    Ok((!excerpt.is_empty()).then_some(excerpt))
}

pub fn clear_task_failure_log(app: &AppHandle, task_id: &str) -> Result<()> {
    let log_dir = task_log_dir(app, task_id)?;
    if log_dir.exists() {
        fs::remove_dir_all(&log_dir).with_context(|| {
            format!("Failed to remove task log directory {}.", log_dir.display())
        })?;
    }
    Ok(())
}

fn clear_task_failure_scope(app: &AppHandle, scope: &str) -> Result<()> {
    let path = task_failure_scope_path(app, scope)?;
    if !path.exists() {
        return Ok(());
    }

    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(task) = serde_json::from_str::<BackgroundTask>(&raw) {
            let _ = clear_task_failure_log(app, &task.id);
        }
    }

    fs::remove_file(&path)
        .with_context(|| format!("Failed to remove task failure {}.", path.display()))?;
    Ok(())
}

pub fn clear_session_task_failure(app: &AppHandle, session_id: &str) -> Result<()> {
    clear_task_failure_scope(app, &format!("session-{}", sanitize_path_part(session_id)))
}

pub fn clear_model_task_failure(app: &AppHandle, model_id: &str) -> Result<()> {
    clear_task_failure_scope(app, &format!("model-{}", sanitize_path_part(model_id)))
}

pub fn write_task_command_failure_log(
    app: &AppHandle,
    task_id: &str,
    command_label: &str,
    program_path: &Path,
    args: &[&str],
    exit_code: Option<i32>,
    stderr_path: Option<&Path>,
    fallback_stderr: Option<&str>,
) -> Result<TaskFailureLog> {
    let log_path = task_failure_log_path(app, task_id)?;
    ensure_parent_dir(&log_path)?;
    let stderr_excerpt = stderr_path
        .map(read_tail_excerpt)
        .transpose()?
        .flatten()
        .or_else(|| {
            fallback_stderr
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
    let log = TaskFailureLog {
        occurred_at: chrono::Utc::now().to_rfc3339(),
        command_label: Some(command_label.to_string()),
        command: Some(command_summary(program_path, args)),
        exit_code,
        stderr_excerpt,
        log_path: Some(log_path.display().to_string()),
        stderr_path: stderr_path.map(|path| path.display().to_string()),
    };
    let raw =
        serde_json::to_string_pretty(&log).context("Failed to serialize task failure log.")?;
    fs::write(&log_path, raw)
        .with_context(|| format!("Failed to write task failure log {}.", log_path.display()))?;
    Ok(log)
}

pub fn write_task_error_log(app: &AppHandle, task_id: &str, error: &str) -> Result<TaskFailureLog> {
    let log_path = task_failure_log_path(app, task_id)?;
    ensure_parent_dir(&log_path)?;
    let log = TaskFailureLog {
        occurred_at: chrono::Utc::now().to_rfc3339(),
        command_label: None,
        command: None,
        exit_code: None,
        stderr_excerpt: Some(error.trim().to_string()),
        log_path: Some(log_path.display().to_string()),
        stderr_path: None,
    };
    let raw =
        serde_json::to_string_pretty(&log).context("Failed to serialize task failure log.")?;
    fs::write(&log_path, raw)
        .with_context(|| format!("Failed to write task failure log {}.", log_path.display()))?;
    Ok(log)
}

pub fn read_task_failure_log(app: &AppHandle, task_id: &str) -> Result<Option<TaskFailureLog>> {
    let path = task_failure_log_path(app, task_id)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read task failure log {}.", path.display()))?;
    let log = serde_json::from_str::<TaskFailureLog>(&raw)
        .with_context(|| format!("Failed to parse task failure log {}.", path.display()))?;
    Ok(Some(log))
}

pub fn persist_failed_task(app: &AppHandle, task: &BackgroundTask) -> Result<()> {
    let path = task_failure_scope_path(app, &task_failure_scope(task))?;
    ensure_parent_dir(&path)?;
    let raw = serde_json::to_string_pretty(task).context("Failed to serialize failed task.")?;
    fs::write(&path, raw)
        .with_context(|| format!("Failed to persist failed task {}.", path.display()))?;
    Ok(())
}

pub fn list_persisted_failed_tasks(app: &AppHandle) -> Result<Vec<BackgroundTask>> {
    let failures_dir = app_data_dir(app)?.join(TASK_FAILURES_DIR_NAME);
    if !failures_dir.exists() {
        return Ok(Vec::new());
    }

    let mut tasks = Vec::new();
    for entry in fs::read_dir(&failures_dir).with_context(|| {
        format!(
            "Failed to read task failures directory {}.",
            failures_dir.display()
        )
    })? {
        let entry = entry.context("Failed to read task failure entry.")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read task failure {}.", path.display()))?;
        if let Ok(task) = serde_json::from_str::<BackgroundTask>(&raw) {
            tasks.push(task);
        }
    }

    Ok(tasks)
}

pub fn app_models_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join("models"))
}

pub fn app_runtime_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join("runtime"))
}

fn target_binary_file_name(binary_name: &str) -> String {
    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    format!("{}-{}{}", binary_name, current_target_triple(), extension)
}

fn whisper_runtime_file_name() -> String {
    target_binary_file_name("whisper-cli")
}

fn managed_whisper_cli_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_runtime_dir(app)?.join(whisper_runtime_file_name()))
}

pub fn is_managed_whisper_cli_path(app: &AppHandle, path: &Path) -> bool {
    managed_whisper_cli_path(app)
        .map(|managed_path| managed_path == path)
        .unwrap_or(false)
}

pub fn delete_managed_whisper_runtime(app: &AppHandle) -> Result<()> {
    let path = managed_whisper_cli_path(app)?;
    if path.exists() {
        fs::remove_file(&path).with_context(|| {
            format!(
                "Failed to remove the managed whisper runtime at {}.",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn processing_settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(PROCESSING_SETTINGS_FILE_NAME))
}

pub fn load_processing_settings(app: &AppHandle) -> Result<ProcessingSettings> {
    let path = processing_settings_path(app)?;
    if !path.exists() {
        return Ok(ProcessingSettings::default());
    }

    let raw =
        fs::read_to_string(&path).with_context(|| format!("Failed to read {}.", path.display()))?;
    let settings = serde_json::from_str::<ProcessingSettings>(&raw).unwrap_or_default();
    Ok(normalize_processing_settings(settings))
}

pub fn persist_processing_settings(app: &AppHandle, settings: &ProcessingSettings) -> Result<()> {
    let path = processing_settings_path(app)?;
    ensure_parent_dir(&path)?;
    let payload = serde_json::to_string_pretty(&normalize_processing_settings(settings.clone()))
        .context("Failed to serialize processing settings.")?;
    write_text_if_changed(&path, &payload, "Failed to write processing settings.")?;
    Ok(())
}

pub fn normalize_processing_settings(mut settings: ProcessingSettings) -> ProcessingSettings {
    settings.language = normalize_whisper_language_code(&settings.language);

    settings.prompt_terms = settings.prompt_terms.trim().to_string();
    settings.preferred_model_id = settings
        .preferred_model_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if settings.quality_preset != ProcessingQualityPreset::Custom {
        match settings.quality_preset {
            ProcessingQualityPreset::Fast => {
                settings.chunk_duration_minutes = 5;
                settings.chunk_overlap_seconds = 10;
                settings.max_parallel_chunks = 1;
            }
            ProcessingQualityPreset::Balanced => {
                settings.chunk_duration_minutes = 10;
                settings.chunk_overlap_seconds = 20;
                settings.max_parallel_chunks = 1;
            }
            ProcessingQualityPreset::Accurate => {
                settings.chunk_duration_minutes = 15;
                settings.chunk_overlap_seconds = 30;
                settings.max_parallel_chunks = 1;
            }
            ProcessingQualityPreset::Custom => {}
        }
    }

    settings.chunk_duration_minutes = settings.chunk_duration_minutes.clamp(1, 60);
    settings.chunk_overlap_seconds = settings.chunk_overlap_seconds.min(120);
    settings.max_parallel_chunks = settings.max_parallel_chunks.clamp(1, 4);
    settings.live_refresh_interval_seconds = settings.live_refresh_interval_seconds.clamp(10, 60);
    settings.whisper_threads = settings
        .whisper_threads
        .filter(|value| *value > 0)
        .map(|value| value.min(16));

    settings
}

fn normalize_whisper_language_code(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    if normalized.is_empty() {
        return String::from("auto");
    }

    match normalized.as_str() {
        "automatic" | "detect" => String::from("auto"),
        "english" => String::from("en"),
        "japanese" | "jp" => String::from("ja"),
        "chinese" | "cn" | "zh-cn" | "zh-hans" => String::from("zh"),
        "korean" | "kr" => String::from("ko"),
        _ => normalized,
    }
}

pub fn sessions_file_path(app: &AppHandle) -> Result<PathBuf> {
    let base_dir = app_data_dir(app)?;

    Ok(base_dir.join(SESSIONS_FILE_NAME))
}

pub fn sessions_root_dir(app: &AppHandle) -> Result<PathBuf> {
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

fn polished_transcript_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(POLISHED_TRANSCRIPT_FILE_NAME))
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

fn chunk_transcript_json_path(
    app: &AppHandle,
    session_id: &str,
    chunk_index: usize,
) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(CHUNKS_DIR_NAME)
        .join(format!("chunk-{chunk_index:03}.json")))
}

fn live_transcript_json_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_TRANSCRIPT_JSON_FILE_NAME))
}

fn live_transcript_window_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_TRANSCRIPT_WINDOW_AUDIO_FILE_NAME))
}

fn exports_dir_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?.join(EXPORTS_DIR_NAME))
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
    let polished_path = polished_transcript_path(app, &session.id)?;
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

    let polished_value = polished_path.display().to_string();
    if session.polished_transcript_path.as_deref() != Some(polished_value.as_str()) {
        session.polished_transcript_path = Some(polished_value);
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

pub fn resolve_ffmpeg_path(app: &AppHandle) -> PathBuf {
    let target_binary_name = target_binary_file_name("ffmpeg");
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("LECLOG_FFMPEG_PATH") {
        candidates.push(PathBuf::from(path));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&target_binary_name),
    );

    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("ffmpeg"));
            candidates.push(exe_dir.join(&target_binary_name));
            #[cfg(target_os = "windows")]
            candidates.push(exe_dir.join("ffmpeg.exe"));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.extend([
            resource_dir.join(&target_binary_name),
            resource_dir.join("binaries").join(&target_binary_name),
        ]);
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
        PathBuf::from("ffmpeg"),
    ]);

    let fallback = candidates
        .iter()
        .find(|candidate| candidate.components().count() == 1 || candidate.exists())
        .cloned()
        .unwrap_or_else(|| PathBuf::from("ffmpeg"));

    candidates
        .into_iter()
        .find(|candidate| command_candidate_available(candidate, "-version"))
        .unwrap_or(fallback)
}

fn command_candidate_available(candidate: &Path, probe_arg: &str) -> bool {
    if candidate.components().count() > 1 && !candidate.exists() {
        return false;
    }

    Command::new(candidate)
        .arg(probe_arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn resolve_whisper_cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = env::var("LECLOG_WHISPER_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    if let Ok(candidate) = managed_whisper_cli_path(app) {
        if candidate.exists() {
            return candidate;
        }
    }

    let target_binary_name = target_binary_file_name("whisper-cli");
    let local_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&target_binary_name);
    if local_sidecar.exists() {
        return local_sidecar;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(&target_binary_name),
            resource_dir.join("binaries").join(&target_binary_name),
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

fn resolve_whisper_model_path(
    app: &AppHandle,
    preferred_model_id: Option<&str>,
) -> Option<PathBuf> {
    if let Ok(path) = env::var("LECLOG_WHISPER_MODEL_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Some(preferred_model_id) = preferred_model_id {
        let preferred_model_id = preferred_model_id.trim();
        if !preferred_model_id.is_empty() {
            for dir in model_search_dirs(app) {
                let candidate = dir.join(preferred_model_id);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    for dir in model_search_dirs(app) {
        for file_name in DEFAULT_WHISPER_MODEL_FILE_NAMES {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn model_search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut search_dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")];

    if let Ok(models_dir) = app_models_dir(app) {
        search_dirs.push(models_dir);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        search_dirs.push(resource_dir.join("models"));
        search_dirs.push(resource_dir);
    }

    search_dirs
}

fn model_catalog() -> Vec<ManagedTranscriptionModel> {
    MANAGED_MODEL_CATALOG
        .iter()
        .map(
            |(id, label, size_bytes, recommended)| ManagedTranscriptionModel {
                id: (*id).to_string(),
                label: (*label).to_string(),
                source_url: format!("{MODEL_REPOSITORY_BASE_URL}/{id}?download=true"),
                size_bytes: *size_bytes,
                recommended: *recommended,
                installed: false,
                installed_path: None,
                download_status: ModelDownloadStatus::Idle,
                downloaded_bytes: 0,
                total_bytes: Some(*size_bytes),
                error: None,
                managed_by_app: false,
            },
        )
        .collect()
}

pub fn find_model_path_by_id(app: &AppHandle, model_id: &str) -> Option<PathBuf> {
    let trimmed_id = model_id.trim();
    if trimmed_id.is_empty() {
        return None;
    }

    for dir in model_search_dirs(app) {
        let candidate = dir.join(trimmed_id);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn first_existing_model_id(app: &AppHandle, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| find_model_path_by_id(app, candidate).is_some())
        .map(|candidate| (*candidate).to_string())
}

fn resolve_preferred_model_for_settings(
    app: &AppHandle,
    settings: &ProcessingSettings,
) -> Option<String> {
    if let Some(model_id) = settings.preferred_model_id.as_deref() {
        if find_model_path_by_id(app, model_id).is_some() {
            return Some(model_id.to_string());
        }
    }

    match settings.quality_preset {
        ProcessingQualityPreset::Fast => first_existing_model_id(
            app,
            &[
                "ggml-base.bin",
                "ggml-tiny.bin",
                "ggml-base.en.bin",
                "ggml-tiny.en.bin",
            ],
        ),
        ProcessingQualityPreset::Balanced => first_existing_model_id(
            app,
            &[
                "ggml-small.bin",
                "ggml-base.bin",
                "ggml-small.en.bin",
                "ggml-base.en.bin",
            ],
        ),
        ProcessingQualityPreset::Accurate => first_existing_model_id(
            app,
            &[
                "ggml-large-v3-turbo-q5_0.bin",
                "ggml-large-v3-turbo.bin",
                "ggml-small.bin",
                "ggml-base.bin",
            ],
        ),
        ProcessingQualityPreset::Custom => settings.preferred_model_id.clone(),
    }
}

fn resolve_whisper_threads(settings: &ProcessingSettings) -> u32 {
    if let Some(threads) = settings.whisper_threads {
        return threads.clamp(1, 16);
    }

    let available = std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(4);
    available.saturating_sub(2).clamp(2, 8)
}

pub fn list_available_transcription_models(
    app: &AppHandle,
    download_jobs: &std::collections::HashMap<String, ManagedTranscriptionModel>,
) -> Vec<ManagedTranscriptionModel> {
    let mut models = model_catalog();
    for model in &mut models {
        if let Some(path) = find_model_path_by_id(app, &model.id) {
            model.installed = true;
            model.installed_path = Some(path.display().to_string());
            model.managed_by_app = path.starts_with(app_models_dir(app).unwrap_or_default());
            model.download_status = ModelDownloadStatus::Completed;
            model.downloaded_bytes = std::fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(model.size_bytes);
            model.total_bytes = Some(model.downloaded_bytes);
        }

        if let Some(job) = download_jobs.get(&model.id) {
            model.download_status = job.download_status.clone();
            model.downloaded_bytes = job.downloaded_bytes;
            model.total_bytes = job.total_bytes;
            model.error = job.error.clone();
            if job.installed {
                model.installed = true;
                model.installed_path = job.installed_path.clone();
                model.managed_by_app = job.managed_by_app;
            }
        }
    }

    models.sort_by(|left, right| {
        right
            .recommended
            .cmp(&left.recommended)
            .then(right.installed.cmp(&left.installed))
            .then(left.size_bytes.cmp(&right.size_bytes))
    });
    models
}

pub fn download_transcription_model<F>(
    app: &AppHandle,
    model_id: &str,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, Option<u64>) -> Result<(), String>,
{
    let catalog_item = model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .context("Unsupported transcription model.")?;
    let models_dir = app_models_dir(app)?;
    fs::create_dir_all(&models_dir).context("Failed to create the models directory.")?;
    let destination_path = models_dir.join(&catalog_item.id);
    if destination_path.exists() {
        return Ok(destination_path);
    }

    let temp_path = models_dir.join(format!("{}.part", &catalog_item.id));
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    let client = Client::builder()
        .build()
        .context("Failed to initialize the HTTP client.")?;
    let mut response = client
        .get(&catalog_item.source_url)
        .send()
        .with_context(|| format!("Failed to download {}.", catalog_item.label))?
        .error_for_status()
        .with_context(|| {
            format!(
                "The model server rejected the download for {}.",
                catalog_item.label
            )
        })?;

    let total_bytes = response.content_length().or(Some(catalog_item.size_bytes));
    let mut file = fs::File::create(&temp_path)
        .with_context(|| format!("Failed to create {}.", temp_path.display()))?;
    let mut downloaded_bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = std::io::Read::read(&mut response, &mut buffer)
            .context("Failed to read the model download stream.")?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])
            .context("Failed to write model bytes to disk.")?;
        downloaded_bytes = downloaded_bytes.saturating_add(read as u64);
        on_progress(downloaded_bytes, total_bytes).map_err(|error| anyhow::anyhow!(error))?;
    }

    fs::rename(&temp_path, &destination_path)
        .with_context(|| format!("Failed to finalize {}.", destination_path.display()))?;
    Ok(destination_path)
}

fn whisper_runtime_source_url() -> String {
    env::var("LECLOG_WHISPER_RUNTIME_URL").unwrap_or_else(|_| {
        format!(
            "{WHISPER_RUNTIME_REPOSITORY_BASE_URL}/{}",
            whisper_runtime_file_name()
        )
    })
}

fn expected_whisper_runtime_sha256() -> Option<String> {
    env::var("LECLOG_WHISPER_RUNTIME_SHA256")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

fn parse_sha256_checksum(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .find(|part| {
            part.len() == 64 && part.chars().all(|character| character.is_ascii_hexdigit())
        })
        .map(|value| value.to_ascii_lowercase())
}

fn fetch_whisper_runtime_sha256(client: &Client, source_url: &str) -> Result<String> {
    if let Some(expected) = expected_whisper_runtime_sha256() {
        return Ok(expected);
    }

    let checksum_url = format!("{source_url}.sha256");
    let checksum_response = client
        .get(&checksum_url)
        .send()
        .with_context(|| format!("Failed to download whisper-cli checksum from {checksum_url}."))?
        .error_for_status()
        .with_context(|| format!("The runtime server rejected {checksum_url}."))?;
    let checksum_text = checksum_response
        .text()
        .context("Failed to read the runtime checksum response.")?;

    parse_sha256_checksum(&checksum_text).with_context(|| {
        format!("The runtime checksum response from {checksum_url} did not contain a SHA-256 hash.")
    })
}

pub fn download_whisper_runtime<F>(app: &AppHandle, mut on_progress: F) -> Result<PathBuf>
where
    F: FnMut(u64, Option<u64>) -> Result<(), String>,
{
    let destination_path = managed_whisper_cli_path(app)?;
    if destination_path.exists() {
        return Ok(destination_path);
    }

    let runtime_dir = app_runtime_dir(app)?;
    fs::create_dir_all(&runtime_dir).context("Failed to create the runtime directory.")?;
    let temp_path = runtime_dir.join(format!("{}.part", whisper_runtime_file_name()));
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    let source_url = whisper_runtime_source_url();
    let client = Client::builder()
        .build()
        .context("Failed to initialize the HTTP client.")?;
    let expected_sha256 = fetch_whisper_runtime_sha256(&client, &source_url)?;
    let mut response = client
        .get(&source_url)
        .send()
        .with_context(|| format!("Failed to download whisper-cli from {source_url}."))?
        .error_for_status()
        .with_context(|| format!("The runtime server rejected {source_url}."))?;

    let total_bytes = response.content_length();
    let mut file = fs::File::create(&temp_path)
        .with_context(|| format!("Failed to create {}.", temp_path.display()))?;
    let mut downloaded_bytes = 0u64;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = std::io::Read::read(&mut response, &mut buffer)
            .context("Failed to read the runtime download stream.")?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])
            .context("Failed to write runtime bytes to disk.")?;
        hasher.update(&buffer[..read]);
        downloaded_bytes = downloaded_bytes.saturating_add(read as u64);
        on_progress(downloaded_bytes, total_bytes).map_err(|error| anyhow::anyhow!(error))?;
    }
    drop(file);

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        let _ = fs::remove_file(&temp_path);
        anyhow::bail!(
            "Downloaded whisper-cli did not match the expected checksum. Expected {expected_sha256}, got {actual_sha256}."
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(&temp_path)
            .with_context(|| format!("Failed to inspect {}.", temp_path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temp_path, permissions)
            .with_context(|| format!("Failed to mark {} executable.", temp_path.display()))?;
    }

    fs::rename(&temp_path, &destination_path)
        .with_context(|| format!("Failed to finalize {}.", destination_path.display()))?;
    Ok(destination_path)
}

pub fn delete_managed_transcription_model(app: &AppHandle, model_id: &str) -> Result<()> {
    let path = app_models_dir(app)?.join(model_id);
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("Failed to remove the model file at {}.", path.display()))?;
    }
    Ok(())
}

pub fn path_size_bytes(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }

    let metadata = fs::metadata(path)
        .with_context(|| format!("Failed to read metadata for {}.", path.display()))?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0u64;
    for entry in fs::read_dir(path)
        .with_context(|| format!("Failed to read directory {}.", path.display()))?
    {
        let entry = entry?;
        total = total.saturating_add(path_size_bytes(&entry.path())?);
    }
    Ok(total)
}

pub fn list_partial_downloads(app: &AppHandle) -> Result<Vec<PathBuf>> {
    let models_dir = app_models_dir(app)?;
    if !models_dir.exists() {
        return Ok(Vec::new());
    }

    let mut partials = Vec::new();
    for entry in fs::read_dir(&models_dir)
        .with_context(|| format!("Failed to read model directory {}.", models_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension == "part")
        {
            partials.push(path);
        }
    }
    Ok(partials)
}

pub fn is_inside_app_data(app: &AppHandle, path: &Path) -> Result<bool> {
    let app_data = app_data_dir(app)?;
    let canonical_app_data = app_data.canonicalize().unwrap_or(app_data);
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Ok(canonical_path.starts_with(canonical_app_data))
}

fn is_task_canceled(app: &AppHandle, task_id: Option<&str>) -> bool {
    task_id
        .and_then(|task_id| {
            app.try_state::<TranscriptionTaskState>()
                .and_then(|state| state.is_canceled(task_id).ok())
        })
        .unwrap_or(false)
}

fn run_command_with_optional_task(
    app: &AppHandle,
    program_path: &Path,
    args: &[&str],
    task_id: Option<&str>,
    label: &str,
) -> Result<()> {
    if task_id.is_none() {
        let output = Command::new(program_path)
            .args(args)
            .output()
            .with_context(|| format!("Failed to launch {label} at {}.", program_path.display()))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{label} failed: {}", stderr.trim());
    }

    let task_id = task_id.expect("task id was checked above");
    clear_task_failure_log(app, task_id).ok();
    let stderr_path = task_stderr_path(app, task_id)?;
    ensure_parent_dir(&stderr_path)?;
    let stderr_file = fs::File::create(&stderr_path).with_context(|| {
        format!(
            "Failed to create task stderr log {}.",
            stderr_path.display()
        )
    })?;
    let mut child = Command::new(program_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| {
            let message = format!(
                "Failed to launch {label} at {}: {error}",
                program_path.display()
            );
            let _ = write_task_command_failure_log(
                app,
                task_id,
                label,
                program_path,
                args,
                None,
                Some(&stderr_path),
                Some(&message),
            );
            anyhow::anyhow!(message)
        })?;

    loop {
        if is_task_canceled(app, Some(task_id)) {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("Task canceled.");
        }

        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("Failed to wait for {label}."))?
        {
            if status.success() {
                let _ = clear_task_failure_log(app, task_id);
                return Ok(());
            }

            let _ = write_task_command_failure_log(
                app,
                task_id,
                label,
                program_path,
                args,
                status.code(),
                Some(&stderr_path),
                None,
            );
            anyhow::bail!("{label} failed with status {status}.");
        }

        thread::sleep(Duration::from_millis(150));
    }
}

fn run_ffmpeg(app: &AppHandle, args: &[&str], task_id: Option<&str>) -> Result<()> {
    let ffmpeg_path = resolve_ffmpeg_path(app);
    run_command_with_optional_task(app, &ffmpeg_path, args, task_id, "ffmpeg")
}

fn run_whisper_cli(app: &AppHandle, args: &[&str], task_id: Option<&str>) -> Result<()> {
    let whisper_cli_path = resolve_whisper_cli_path(app);
    run_command_with_optional_task(app, &whisper_cli_path, args, task_id, "whisper-cli")
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
        let text = normalize_transcript_text(text);
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
            text,
            is_final,
        });
    }

    if segments.is_empty() {
        anyhow::bail!("whisper.cpp completed, but no transcript text was produced.");
    }

    Ok(rewrite_transcript_segments(segments, is_final))
}

fn squeeze_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_punctuation_spacing(value: &str) -> String {
    value
        .replace(" 。", "。")
        .replace(" 、", "、")
        .replace(" ？", "？")
        .replace(" ！", "！")
        .replace(" .", ".")
        .replace(" ,", ",")
        .replace(" ?", "?")
        .replace(" !", "!")
}

fn collapse_repeated_punctuation(value: &str) -> String {
    let mut normalized = value.to_string();
    for (from, to) in [
        ("。。", "。"),
        ("、、", "、"),
        ("？？", "？"),
        ("！！", "！"),
        ("..", "."),
        (",,", ","),
        ("??", "?"),
        ("!!", "!"),
    ] {
        while normalized.contains(from) {
            normalized = normalized.replace(from, to);
        }
    }
    normalized
}

fn has_terminal_punctuation(value: &str) -> bool {
    let trimmed = value.trim_end();
    trimmed.ends_with('。')
        || trimmed.ends_with('！')
        || trimmed.ends_with('？')
        || trimmed.ends_with('.')
        || trimmed.ends_with('!')
        || trimmed.ends_with('?')
}

fn looks_like_question(value: &str) -> bool {
    let trimmed = value.trim_end();
    trimmed.ends_with('か')
        || trimmed.ends_with("ですか")
        || trimmed.ends_with("ますか")
        || trimmed.ends_with("でしょうか")
}

fn normalize_transcript_text(text: &str) -> String {
    let mut normalized =
        collapse_repeated_punctuation(&normalize_punctuation_spacing(&squeeze_whitespace(text)))
            .trim()
            .to_string();
    if normalized.is_empty() {
        return normalized;
    }

    if normalized.ends_with('、') || normalized.ends_with(',') {
        normalized.pop();
        normalized = normalized.trim_end().to_string();
    }

    normalized
}

fn finalize_sentence_text(text: &str, is_final: bool) -> String {
    let mut normalized = normalize_transcript_text(text);
    if normalized.is_empty() {
        return normalized;
    }

    if is_final && !has_terminal_punctuation(&normalized) {
        if looks_like_question(&normalized) {
            normalized.push('？');
        } else {
            normalized.push('。');
        }
    }

    normalized
}

fn merge_transcript_text(left: &str, right: &str) -> String {
    if left.is_empty() {
        return right.to_string();
    }

    if right.is_empty() {
        return left.to_string();
    }

    let right_starts_with_punctuation = right.starts_with('、')
        || right.starts_with('。')
        || right.starts_with('？')
        || right.starts_with('！');
    let needs_space = left
        .chars()
        .last()
        .is_some_and(|value| value.is_ascii_alphanumeric())
        && right
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric());

    if right_starts_with_punctuation {
        format!("{left}{right}")
    } else if needs_space {
        format!("{left} {right}")
    } else {
        format!("{left}{right}")
    }
}

fn is_terminal_punctuation(char: char) -> bool {
    matches!(char, '。' | '？' | '！' | '.' | '?' | '!')
}

fn likely_sentence_boundary(text: &str, is_final: bool) -> bool {
    if has_terminal_punctuation(text) {
        return true;
    }

    if !is_final {
        return false;
    }

    let trimmed = text.trim_end_matches(['、', ',', ' ']);
    let char_len = trimmed.chars().count();
    let common_japanese_endings = [
        "です",
        "ます",
        "でした",
        "ました",
        "ません",
        "ください",
        "ましょう",
        "と思います",
        "になります",
        "ということです",
        "なんですね",
        "ですよね",
        "ですね",
        "でしたね",
        "でしょう",
        "でしょうか",
        "ですか",
        "ますか",
    ];

    (char_len >= 8
        && common_japanese_endings
            .iter()
            .any(|ending| trimmed.ends_with(ending)))
        || char_len >= 28
}

fn split_text_into_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut buffer = String::new();

    for char in text.chars() {
        buffer.push(char);
        if is_terminal_punctuation(char) {
            let sentence = buffer.trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_string());
            }
            buffer.clear();
        }
    }

    let remainder = buffer.trim();
    if !remainder.is_empty() {
        sentences.push(remainder.to_string());
    }

    sentences
}

fn split_segment_into_sentences(segment: TranscriptSegment) -> Vec<TranscriptSegment> {
    let sentences = split_text_into_sentences(&segment.text);
    if sentences.len() <= 1 {
        return vec![segment];
    }

    let sentence_count = sentences.len();
    let total_chars = sentences
        .iter()
        .map(|sentence| sentence.chars().count().max(1))
        .sum::<usize>()
        .max(1) as u64;
    let total_duration = segment.end_ms.saturating_sub(segment.start_ms).max(1);

    let mut cursor = segment.start_ms;
    let mut consumed_chars = 0u64;
    let mut rewritten = Vec::new();

    for (index, sentence) in sentences.into_iter().enumerate() {
        let sentence_chars = sentence.chars().count().max(1) as u64;
        consumed_chars = consumed_chars.saturating_add(sentence_chars);
        let end_ms = if index == 0 && sentence_chars == total_chars {
            segment.end_ms
        } else if index + 1 == sentence_count {
            segment.end_ms
        } else if consumed_chars >= total_chars {
            segment.end_ms
        } else {
            segment.start_ms + total_duration.saturating_mul(consumed_chars) / total_chars
        }
        .max(cursor.saturating_add(1))
        .min(segment.end_ms);

        rewritten.push(TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            start_ms: cursor,
            end_ms,
            text: sentence,
            is_final: segment.is_final,
        });

        cursor = end_ms;
    }

    if let Some(last) = rewritten.last_mut() {
        last.end_ms = segment.end_ms.max(last.start_ms.saturating_add(1));
    }

    rewritten
}

fn should_insert_space_between_sentences(left: &str, right: &str) -> bool {
    left.chars()
        .last()
        .is_some_and(|value| value.is_ascii_alphanumeric())
        && right
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
}

pub fn polish_transcript_text(segments: &[TranscriptSegment]) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current_paragraph = String::new();
    let mut current_sentence_count = 0usize;
    let mut last_end_ms: Option<u64> = None;
    let mut last_text: Option<String> = None;

    for segment in segments {
        let sentence = finalize_sentence_text(&segment.text, true);
        if sentence.is_empty() {
            continue;
        }

        if last_text.as_deref() == Some(sentence.as_str()) {
            last_end_ms = Some(segment.end_ms);
            continue;
        }

        let gap_ms = last_end_ms
            .map(|end_ms| segment.start_ms.saturating_sub(end_ms))
            .unwrap_or(0);
        let paragraph_char_len = current_paragraph.chars().count();
        let paragraph_break = !current_paragraph.is_empty()
            && (gap_ms >= 3200
                || (current_sentence_count >= 4 && paragraph_char_len >= 70)
                || (gap_ms >= 1800 && sentence.ends_with('？')));

        if paragraph_break {
            paragraphs.push(current_paragraph.trim().to_string());
            current_paragraph.clear();
            current_sentence_count = 0;
        }

        if current_paragraph.is_empty() {
            current_paragraph.push_str(&sentence);
        } else if should_insert_space_between_sentences(&current_paragraph, &sentence) {
            current_paragraph.push(' ');
            current_paragraph.push_str(&sentence);
        } else {
            current_paragraph.push_str(&sentence);
        }

        current_sentence_count += 1;
        last_end_ms = Some(segment.end_ms);
        last_text = Some(sentence);
    }

    if !current_paragraph.trim().is_empty() {
        paragraphs.push(current_paragraph.trim().to_string());
    }

    paragraphs.join("\n\n")
}

fn rewrite_transcript_segments(
    segments: Vec<TranscriptSegment>,
    is_final: bool,
) -> Vec<TranscriptSegment> {
    let mut rewritten = Vec::new();
    let mut active: Option<TranscriptSegment> = None;

    for segment in segments {
        if let Some(current) = active.as_mut() {
            current.text = merge_transcript_text(&current.text, &segment.text);
            current.end_ms = segment.end_ms;
            current.is_final = segment.is_final;

            if likely_sentence_boundary(&current.text, is_final) {
                let finalized = TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    start_ms: current.start_ms,
                    end_ms: current.end_ms,
                    text: finalize_sentence_text(&current.text, is_final),
                    is_final: segment.is_final,
                };
                rewritten.extend(split_segment_into_sentences(finalized));
                active = None;
            }
            continue;
        }

        let mut next = segment;
        next.text = normalize_transcript_text(&next.text);
        if next.text.is_empty() {
            continue;
        }

        if likely_sentence_boundary(&next.text, is_final) {
            next.text = finalize_sentence_text(&next.text, is_final);
            rewritten.extend(split_segment_into_sentences(next));
        } else {
            active = Some(next);
        }
    }

    if let Some(mut remainder) = active {
        remainder.text = finalize_sentence_text(&remainder.text, is_final);
        rewritten.extend(split_segment_into_sentences(remainder));
    }

    rewritten
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

pub fn append_audio_chunk_to_path(path: &Path, chunk: &[u8]) -> Result<()> {
    ensure_parent_dir(path)?;

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

fn sanitize_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        String::from("imported-media")
    } else {
        sanitized
    }
}

fn guess_media_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "wav" => Some("audio/wav"),
        "aac" => Some("audio/aac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "flac" => Some("audio/flac"),
        "webm" => Some("audio/webm"),
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

pub fn import_media_file(
    app: &AppHandle,
    session: &mut LectureSession,
    source_path: &Path,
) -> Result<()> {
    if !source_path.exists() || !source_path.is_file() {
        anyhow::bail!("The dropped file does not exist: {}", source_path.display());
    }

    ensure_session_paths(app, session)?;

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("media");
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("imported-media");
    let sanitized_stem = sanitize_file_stem(stem);
    let destination_path = session_dir_path(app, &session.id)?
        .join("audio")
        .join(format!(
            "{sanitized_stem}.{}",
            extension.trim_start_matches('.')
        ));

    ensure_parent_dir(&destination_path)?;
    fs::copy(source_path, &destination_path).with_context(|| {
        format!(
            "Failed to copy the imported media file from {} to {}.",
            source_path.display(),
            destination_path.display()
        )
    })?;

    session.active_audio_file_path = None;
    session.audio_file_paths = vec![destination_path.display().to_string()];
    session.audio_mime_type = guess_media_mime_type(source_path).map(str::to_string);
    session.capture_target_label = Some(
        source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
    );

    Ok(())
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
    write_text_if_changed(&path, &payload, "Failed to write session metadata.")?;
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

    let sessions = serde_json::from_str::<Vec<LectureSession>>(&raw)
        .context("Failed to parse sessions.json.")?;
    Ok(sessions)
}

pub fn persist_sessions(app: &AppHandle, sessions: &[LectureSession]) -> Result<()> {
    let path = sessions_file_path(app)?;
    ensure_parent_dir(&path)?;

    let payload =
        serde_json::to_string_pretty(sessions).context("Failed to serialize session data.")?;
    write_text_if_changed(&path, &payload, "Failed to write session data to disk.")?;

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
    output.push_str(&format!(
        "Capture files: {}\n",
        session.audio_file_paths.len()
    ));
    if let Some(mime_type) = &session.audio_mime_type {
        output.push_str(&format!("Capture MIME type: {mime_type}\n"));
    }
    if let Some(capture_target_label) = &session.capture_target_label {
        output.push_str(&format!("Capture target: {capture_target_label}\n"));
    }
    if let Some(settings) = &session.processing_settings {
        output.push_str(&format!("Language: {}\n", settings.language));
        if let Some(model_id) = &settings.preferred_model_id {
            output.push_str(&format!("Preferred model: {model_id}\n"));
        }
    }
    if let Some(normalized_audio_path) = &session.normalized_audio_path {
        output.push_str(&format!("Normalized audio: {normalized_audio_path}\n"));
    }
    output.push('\n');

    if let Some(polished_transcript_text) = &session.polished_transcript_text {
        output.push_str("## Polished Transcript\n\n");
        output.push_str(polished_transcript_text.trim());
        output.push_str("\n\n");
    }

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

pub fn write_polished_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let polished_text = session
        .polished_transcript_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("No polished transcript text is available for this session.")?;
    let path = if let Some(path) = &session.polished_transcript_path {
        PathBuf::from(path)
    } else {
        polished_transcript_path(app, &session.id)?
    };
    ensure_parent_dir(&path)?;
    fs::write(path, format!("{polished_text}\n"))
        .context("Failed to write polished transcript artifact.")?;
    Ok(())
}

fn export_extension(format: &SessionExportFormat) -> &'static str {
    match format {
        SessionExportFormat::Txt => "txt",
        SessionExportFormat::Markdown | SessionExportFormat::LectureNotes => "md",
        SessionExportFormat::Srt => "srt",
        SessionExportFormat::Vtt => "vtt",
        SessionExportFormat::Json => "json",
    }
}

fn export_name_suffix(format: &SessionExportFormat, layer: &TranscriptExportLayer) -> &'static str {
    match format {
        SessionExportFormat::Txt => match layer {
            TranscriptExportLayer::Raw => "raw",
            TranscriptExportLayer::Polished => "polished",
            TranscriptExportLayer::Corrected => "corrected",
        },
        SessionExportFormat::Markdown => match layer {
            TranscriptExportLayer::Raw => "raw",
            TranscriptExportLayer::Polished => "polished",
            TranscriptExportLayer::Corrected => "corrected",
        },
        SessionExportFormat::Srt | SessionExportFormat::Vtt => "captions",
        SessionExportFormat::Json => "session",
        SessionExportFormat::LectureNotes => "lecture-notes",
    }
}

fn export_file_name(session: &LectureSession, request: &SessionExportRequest) -> String {
    let extension = export_extension(&request.format);
    let fallback_stem = format!(
        "{}-{}",
        sanitize_path_part(&session.title),
        export_name_suffix(&request.format, &request.layer)
    );
    let requested_stem = request
        .output_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Path::new(value).file_stem().and_then(|stem| stem.to_str()))
        .map(sanitize_path_part)
        .filter(|value| !value.is_empty());
    let stem = requested_stem.unwrap_or(fallback_stem);
    format!("{stem}.{extension}")
}

fn format_duration_clock(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn format_timestamp_label(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

fn format_srt_timestamp(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    let millis = duration_ms % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn format_vtt_timestamp(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    let millis = duration_ms % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{millis:03}")
}

fn raw_transcript_text(session: &LectureSession) -> String {
    session
        .segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn transcript_text_for_layer(
    session: &LectureSession,
    layer: &TranscriptExportLayer,
) -> Result<String> {
    match layer {
        TranscriptExportLayer::Raw => {
            let text = raw_transcript_text(session);
            if text.trim().is_empty() {
                anyhow::bail!("No raw transcript text is available for this session.");
            }
            Ok(text)
        }
        TranscriptExportLayer::Polished => session
            .polished_transcript_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .context("No polished transcript text is available for this session."),
        TranscriptExportLayer::Corrected => {
            anyhow::bail!("Corrected transcript export is not available yet.")
        }
    }
}

fn push_markdown_metadata(output: &mut String, session: &LectureSession, include_resources: bool) {
    output.push_str("## Metadata\n\n");
    output.push_str(&format!("- Session ID: {}\n", session.id));
    output.push_str(&format!("- Created: {}\n", session.created_at));
    output.push_str(&format!("- Updated: {}\n", session.updated_at));
    output.push_str(&format!(
        "- Duration: {}\n",
        format_duration_clock(session.duration_ms)
    ));
    output.push_str(&format!("- Status: {:?}\n", session.status));
    output.push_str(&format!("- Capture source: {:?}\n", session.capture_source));
    output.push_str(&format!(
        "- Transcript phase: {:?}\n",
        session.transcript_phase
    ));
    if let Some(capture_target_label) = &session.capture_target_label {
        output.push_str(&format!("- Capture target: {capture_target_label}\n"));
    }
    if let Some(settings) = &session.processing_settings {
        output.push_str(&format!("- Language: {}\n", settings.language));
        output.push_str(&format!(
            "- Quality preset: {:?}\n",
            settings.quality_preset
        ));
        if let Some(model_id) = &settings.preferred_model_id {
            output.push_str(&format!("- Preferred model: {model_id}\n"));
        }
    }
    if include_resources {
        output.push_str(&format!(
            "- Capture files: {}\n",
            session.audio_file_paths.len()
        ));
        if let Some(normalized_audio_path) = &session.normalized_audio_path {
            output.push_str(&format!("- Normalized audio: {normalized_audio_path}\n"));
        }
        if let Some(processed_transcript_path) = &session.processed_transcript_path {
            output.push_str(&format!(
                "- Raw transcript file: {processed_transcript_path}\n"
            ));
        }
        if let Some(polished_transcript_path) = &session.polished_transcript_path {
            output.push_str(&format!(
                "- Polished transcript file: {polished_transcript_path}\n"
            ));
        }
    }
    output.push('\n');
}

fn render_txt_export(session: &LectureSession, request: &SessionExportRequest) -> Result<String> {
    let mut output = String::new();
    if request.include_metadata {
        output.push_str(&format!("{}\n", session.title));
        output.push_str(&format!("Created: {}\n", session.created_at));
        output.push_str(&format!(
            "Duration: {}\n",
            format_duration_clock(session.duration_ms)
        ));
        output.push_str(&format!("Capture source: {:?}\n", session.capture_source));
        output.push('\n');
    }
    output.push_str(transcript_text_for_layer(session, &request.layer)?.trim());
    output.push('\n');
    Ok(output)
}

fn render_markdown_export(
    session: &LectureSession,
    request: &SessionExportRequest,
) -> Result<String> {
    let mut output = String::new();
    output.push_str(&format!("# {}\n\n", session.title));
    if request.include_metadata {
        push_markdown_metadata(&mut output, session, request.include_resource_paths);
    }
    output.push_str("## Transcript\n\n");
    if request.include_timestamps && request.layer == TranscriptExportLayer::Raw {
        for segment in &session.segments {
            let text = segment.text.trim();
            if text.is_empty() {
                continue;
            }
            output.push_str(&format!(
                "- [{}] {}\n",
                format_timestamp_label(segment.start_ms),
                text
            ));
        }
        if session.segments.is_empty() {
            anyhow::bail!("No timestamped transcript segments are available for this session.");
        }
    } else {
        output.push_str(transcript_text_for_layer(session, &request.layer)?.trim());
        output.push('\n');
    }
    Ok(output)
}

fn caption_segments(session: &LectureSession) -> Vec<(u64, u64, String)> {
    let mut cues = Vec::new();
    let mut last_end_ms = 0_u64;
    for segment in &session.segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let start_ms = segment.start_ms.max(last_end_ms);
        let end_ms = segment.end_ms.max(start_ms.saturating_add(1_000));
        cues.push((start_ms, end_ms, text.to_string()));
        last_end_ms = end_ms;
    }
    cues
}

fn render_srt_export(session: &LectureSession) -> Result<String> {
    let cues = caption_segments(session);
    if cues.is_empty() {
        anyhow::bail!("No timestamped transcript segments are available for caption export.");
    }
    let mut output = String::new();
    for (index, (start_ms, end_ms, text)) in cues.iter().enumerate() {
        output.push_str(&format!("{}\n", index + 1));
        output.push_str(&format!(
            "{} --> {}\n",
            format_srt_timestamp(*start_ms),
            format_srt_timestamp(*end_ms)
        ));
        output.push_str(text);
        output.push_str("\n\n");
    }
    Ok(output)
}

fn render_vtt_export(session: &LectureSession) -> Result<String> {
    let cues = caption_segments(session);
    if cues.is_empty() {
        anyhow::bail!("No timestamped transcript segments are available for caption export.");
    }
    let mut output = String::from("WEBVTT\n\n");
    for (start_ms, end_ms, text) in cues {
        output.push_str(&format!(
            "{} --> {}\n",
            format_vtt_timestamp(start_ms),
            format_vtt_timestamp(end_ms)
        ));
        output.push_str(&text);
        output.push_str("\n\n");
    }
    Ok(output)
}

fn render_json_export(session: &LectureSession, request: &SessionExportRequest) -> Result<String> {
    let resource_paths = if request.include_resource_paths {
        json!({
            "sessionDir": session.session_dir,
            "audioFilePaths": session.audio_file_paths,
            "activeAudioFilePath": session.active_audio_file_path,
            "normalizedAudioPath": session.normalized_audio_path,
            "livePreviewAudioPath": session.live_preview_audio_path,
            "processedTranscriptPath": session.processed_transcript_path,
            "polishedTranscriptPath": session.polished_transcript_path,
        })
    } else {
        Value::Null
    };

    serde_json::to_string_pretty(&json!({
        "schemaVersion": 1,
        "exportedAt": Utc::now().to_rfc3339(),
        "session": {
            "id": session.id,
            "title": session.title,
            "createdAt": session.created_at,
            "updatedAt": session.updated_at,
            "captureSource": session.capture_source,
            "status": session.status,
            "durationMs": session.duration_ms,
            "audioMimeType": session.audio_mime_type,
            "transcriptPhase": session.transcript_phase,
            "transcriptError": session.transcript_error,
            "captureTargetLabel": session.capture_target_label,
        },
        "processingSettings": session.processing_settings,
        "resources": resource_paths,
        "transcript": {
            "segments": session.segments,
            "rawText": raw_transcript_text(session),
            "polishedText": session.polished_transcript_text,
            "correctedText": Value::Null,
        }
    }))
    .context("Failed to serialize session export JSON.")
}

fn render_lecture_notes_export(
    session: &LectureSession,
    request: &SessionExportRequest,
) -> Result<String> {
    let transcript_text = session
        .polished_transcript_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| raw_transcript_text(session));
    if transcript_text.trim().is_empty() {
        anyhow::bail!("No transcript text is available for lecture notes export.");
    }

    let mut output = String::new();
    output.push_str(&format!("# {}\n\n", session.title));
    if request.include_metadata {
        push_markdown_metadata(&mut output, session, request.include_resource_paths);
    }
    output.push_str("## Summary\n\n");
    output.push_str("- \n\n");
    output.push_str("## Key Points\n\n");
    output.push_str("- \n\n");
    output.push_str("## Terms\n\n");
    output.push_str("- \n\n");
    output.push_str("## Questions\n\n");
    output.push_str("- \n\n");
    output.push_str("## Follow-ups\n\n");
    output.push_str("- \n\n");
    output.push_str("## Transcript Appendix\n\n");
    output.push_str(transcript_text.trim());
    output.push('\n');
    Ok(output)
}

pub fn export_session_deliverable(
    app: &AppHandle,
    session: &LectureSession,
    request: &SessionExportRequest,
) -> Result<SessionExportResult> {
    if request.session_id != session.id {
        anyhow::bail!("Export request session id does not match the selected session.");
    }
    if request.layer == TranscriptExportLayer::Corrected {
        anyhow::bail!("Corrected transcript export is not available yet.");
    }

    let payload = match request.format {
        SessionExportFormat::Txt => render_txt_export(session, request)?,
        SessionExportFormat::Markdown => render_markdown_export(session, request)?,
        SessionExportFormat::Srt => render_srt_export(session)?,
        SessionExportFormat::Vtt => render_vtt_export(session)?,
        SessionExportFormat::Json => render_json_export(session, request)?,
        SessionExportFormat::LectureNotes => render_lecture_notes_export(session, request)?,
    };

    let exports_dir = exports_dir_path(app, &session.id)?;
    fs::create_dir_all(&exports_dir).context("Failed to create the session exports directory.")?;
    let file_name = export_file_name(session, request);
    let path = exports_dir.join(&file_name);
    fs::write(&path, payload).context("Failed to write the session export file.")?;
    let size_bytes = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    Ok(SessionExportResult {
        path: path.display().to_string(),
        file_name,
        format: request.format.clone(),
        size_bytes,
    })
}

pub fn list_transcription_models(app: &AppHandle) -> Result<Vec<TranscriptionModelInfo>> {
    let recommended_path = resolve_whisper_model_path(app, None);
    let mut models = Vec::new();

    for dir in model_search_dirs(app) {
        if !dir.exists() {
            continue;
        }

        for entry in fs::read_dir(&dir)
            .with_context(|| format!("Failed to read model directory {}.", dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !(file_name.starts_with("ggml-")
                && (file_name.ends_with(".bin") || file_name.ends_with(".gguf")))
            {
                continue;
            }

            let metadata = entry.metadata()?;
            models.push(TranscriptionModelInfo {
                id: file_name.to_string(),
                label: file_name
                    .trim_start_matches("ggml-")
                    .trim_end_matches(".bin")
                    .trim_end_matches(".gguf")
                    .replace('-', " "),
                path: path.display().to_string(),
                size_bytes: metadata.len(),
                recommended: recommended_path
                    .as_ref()
                    .is_some_and(|value| value == &path),
            });
        }
    }

    models.sort_by(|left, right| {
        right
            .recommended
            .cmp(&left.recommended)
            .then(left.id.cmp(&right.id))
    });
    Ok(models)
}

fn transcribe_audio_path(
    app: &AppHandle,
    audio_path: &Path,
    transcript_json_path: &Path,
    is_final: bool,
    preferred_model_id: Option<&str>,
    language: &str,
    prompt: Option<&str>,
    whisper_threads: u32,
    max_end_ms: Option<u64>,
    task_id: Option<&str>,
) -> Result<Vec<TranscriptSegment>> {
    if !audio_path.exists() {
        anyhow::bail!("The audio file does not exist: {}", audio_path.display());
    }
    let model_path = resolve_whisper_model_path(app, preferred_model_id).context(
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
        String::from("--threads"),
        whisper_threads.to_string(),
        String::from("--output-json"),
        String::from("--output-json-full"),
        String::from("--output-file"),
        output_base_str,
        String::from("--no-prints"),
        String::from("--carry-initial-prompt"),
    ];
    if let Some(prompt) = prompt {
        let trimmed_prompt = prompt.trim();
        if !trimmed_prompt.is_empty() {
            args.push(String::from("--prompt"));
            args.push(trimmed_prompt.to_string());
        }
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();

    run_whisper_cli(app, &arg_refs, task_id)?;

    let raw_transcript = fs::read(&transcript_json_path).with_context(|| {
        format!(
            "Failed to read the whisper transcript JSON at {}.",
            transcript_json_path.display()
        )
    })?;
    let raw_transcript = String::from_utf8_lossy(&raw_transcript).into_owned();

    parse_transcript_segments_with_finality(&raw_transcript, is_final, max_end_ms)
}

fn resolve_whisper_language(preferred_language: Option<&str>) -> String {
    preferred_language
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_whisper_language_code)
        .or_else(|| {
            env::var("LECLOG_WHISPER_LANGUAGE")
                .ok()
                .map(|value| normalize_whisper_language_code(&value))
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| String::from("auto"))
}

fn resolve_whisper_prompt(prompt_terms: Option<&str>) -> Option<String> {
    prompt_terms
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var("LECLOG_WHISPER_PROMPT")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
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

pub fn transcribe_normalized_audio_with_settings<F>(
    app: &AppHandle,
    session: &LectureSession,
    settings: &ProcessingSettings,
    task_id: Option<&str>,
    mut on_chunk_progress: F,
) -> Result<Vec<TranscriptSegment>>
where
    F: FnMut(usize, usize) -> Result<(), String>,
{
    let settings = normalize_processing_settings(settings.clone());
    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio file.")?;
    let language = resolve_whisper_language(Some(&settings.language));
    let prompt = resolve_whisper_prompt(Some(&settings.prompt_terms));
    let preferred_model_id = resolve_preferred_model_for_settings(app, &settings);
    let whisper_threads = resolve_whisper_threads(&settings);
    let chunks = split_normalized_audio_for_transcript(app, session, &settings, task_id)?;
    let total_chunks = chunks.len().max(1);
    let mut merged_segments = Vec::new();
    let mut last_end_ms = 0u64;

    if chunks.is_empty() {
        let transcript_json_path = transcript_json_path(app, &session.id)?;
        return transcribe_audio_path(
            app,
            &normalized_audio_path,
            &transcript_json_path,
            true,
            preferred_model_id.as_deref(),
            &language,
            prompt.as_deref(),
            whisper_threads,
            None,
            task_id,
        );
    }

    for (index, chunk) in chunks.iter().enumerate() {
        if is_task_canceled(app, task_id) {
            anyhow::bail!("Task canceled.");
        }
        on_chunk_progress(index, total_chunks).map_err(|error| anyhow::anyhow!(error))?;
        let transcript_json_path = chunk_transcript_json_path(app, &session.id, index + 1)?;
        let mut segments = transcribe_audio_path(
            app,
            &chunk.path,
            &transcript_json_path,
            true,
            preferred_model_id.as_deref(),
            &language,
            prompt.as_deref(),
            whisper_threads,
            Some(chunk.duration_ms),
            task_id,
        )?;
        for segment in &mut segments {
            segment.start_ms = segment.start_ms.saturating_add(chunk.start_ms);
            segment.end_ms = segment.end_ms.saturating_add(chunk.start_ms);
        }
        for segment in segments {
            if segment.end_ms <= last_end_ms {
                continue;
            }
            last_end_ms = segment.end_ms;
            merged_segments.push(segment);
        }
        on_chunk_progress(index + 1, total_chunks).map_err(|error| anyhow::anyhow!(error))?;
    }

    Ok(rewrite_transcript_segments(merged_segments, true))
}

fn merge_live_transcript_segments(
    existing_segments: &[TranscriptSegment],
    mut refreshed_segments: Vec<TranscriptSegment>,
    refresh_start_ms: u64,
) -> Vec<TranscriptSegment> {
    if refresh_start_ms == 0 {
        return refreshed_segments;
    }

    let mut merged = existing_segments
        .iter()
        .filter(|segment| segment.end_ms <= refresh_start_ms)
        .cloned()
        .collect::<Vec<_>>();
    merged.append(&mut refreshed_segments);
    merged.sort_by_key(|segment| (segment.start_ms, segment.end_ms));
    merged
}

pub fn transcribe_live_preview_audio(
    app: &AppHandle,
    session: &LectureSession,
    preferred_model_id: Option<&str>,
    preferred_language: Option<&str>,
    prompt_terms: Option<&str>,
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
    let language = resolve_whisper_language(preferred_language);
    let prompt = resolve_whisper_prompt(prompt_terms);
    let sample_rate = session.live_preview_sample_rate.unwrap_or(16_000);
    let duration_ms = wav_duration_ms(&live_preview_audio_path, sample_rate)?;
    let previous_end_ms = session
        .segments
        .iter()
        .map(|segment| segment.end_ms)
        .max()
        .unwrap_or(0);
    if !session.segments.is_empty()
        && previous_end_ms <= duration_ms
        && duration_ms <= previous_end_ms.saturating_add(LIVE_TRANSCRIPT_REFRESH_GRACE_MS)
    {
        return Ok(session.segments.clone());
    }

    let window_start_ms = if session.segments.is_empty() {
        0
    } else {
        duration_ms.saturating_sub(LIVE_TRANSCRIPT_WINDOW_MS)
    };
    let transcription_audio_path = if window_start_ms == 0 {
        live_preview_audio_path.clone()
    } else {
        let window_audio_path = live_transcript_window_audio_path(app, &session.id)?;
        ensure_parent_dir(&window_audio_path)?;
        let live_preview_audio_path_str = live_preview_audio_path.to_string_lossy().to_string();
        let window_audio_path_str = window_audio_path.to_string_lossy().to_string();
        let start_seconds = format!("{:.3}", window_start_ms as f64 / 1000.0);
        let duration_seconds = format!("{:.3}", (duration_ms - window_start_ms) as f64 / 1000.0);
        let sample_rate_arg = LIVE_TRANSCRIPT_WINDOW_SAMPLE_RATE.to_string();

        run_ffmpeg(
            app,
            &[
                "-y",
                "-ss",
                &start_seconds,
                "-i",
                &live_preview_audio_path_str,
                "-t",
                &duration_seconds,
                "-ac",
                "1",
                "-ar",
                &sample_rate_arg,
                &window_audio_path_str,
            ],
            None,
        )?;
        window_audio_path
    };
    let max_end_ms = Some(duration_ms - window_start_ms);

    let mut refreshed_segments = transcribe_audio_path(
        app,
        &transcription_audio_path,
        &transcript_json_path,
        false,
        preferred_model_id,
        &language,
        prompt.as_deref(),
        resolve_whisper_threads(&ProcessingSettings::default()),
        max_end_ms,
        None,
    )?;
    if window_start_ms > 0 {
        for segment in &mut refreshed_segments {
            segment.start_ms = segment.start_ms.saturating_add(window_start_ms);
            segment.end_ms = segment.end_ms.saturating_add(window_start_ms);
        }
    }

    Ok(merge_live_transcript_segments(
        &session.segments,
        refreshed_segments,
        window_start_ms,
    ))
}

struct AudioChunk {
    path: PathBuf,
    start_ms: u64,
    duration_ms: u64,
}

fn split_normalized_audio_for_transcript(
    app: &AppHandle,
    session: &LectureSession,
    settings: &ProcessingSettings,
    task_id: Option<&str>,
) -> Result<Vec<AudioChunk>> {
    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio file.")?;
    let duration_ms = wav_duration_ms(&normalized_audio_path, 16_000)?;
    let chunk_ms = u64::from(settings.chunk_duration_minutes.max(1)) * 60 * 1000;
    if duration_ms == 0 || duration_ms <= chunk_ms {
        return Ok(Vec::new());
    }

    let overlap_ms = u64::from(settings.chunk_overlap_seconds) * 1000;
    let chunks_dir = session_dir_path(app, &session.id)?
        .join("processed")
        .join(CHUNKS_DIR_NAME);
    if chunks_dir.exists() {
        fs::remove_dir_all(&chunks_dir)
            .with_context(|| format!("Failed to clear {}.", chunks_dir.display()))?;
    }
    fs::create_dir_all(&chunks_dir)
        .with_context(|| format!("Failed to create {}.", chunks_dir.display()))?;

    let mut chunks = Vec::new();
    let mut start_ms = 0u64;
    let mut index = 1usize;
    let normalized_audio_str = normalized_audio_path.to_string_lossy().to_string();

    while start_ms < duration_ms {
        if is_task_canceled(app, task_id) {
            anyhow::bail!("Task canceled.");
        }

        let end_ms = (start_ms + chunk_ms).min(duration_ms);
        let actual_duration_ms = end_ms.saturating_sub(start_ms);
        let chunk_path = chunks_dir.join(format!("chunk-{index:03}.wav"));
        let chunk_path_str = chunk_path.to_string_lossy().to_string();
        let start_seconds = format!("{:.3}", start_ms as f64 / 1000.0);
        let duration_seconds = format!("{:.3}", actual_duration_ms as f64 / 1000.0);

        run_ffmpeg(
            app,
            &[
                "-y",
                "-ss",
                &start_seconds,
                "-i",
                &normalized_audio_str,
                "-t",
                &duration_seconds,
                "-ac",
                "1",
                "-ar",
                "16000",
                &chunk_path_str,
            ],
            task_id,
        )?;

        chunks.push(AudioChunk {
            path: chunk_path,
            start_ms,
            duration_ms: actual_duration_ms,
        });

        if end_ms >= duration_ms {
            break;
        }
        start_ms = end_ms.saturating_sub(overlap_ms.min(chunk_ms.saturating_sub(1)));
        index += 1;
    }

    Ok(chunks)
}

pub fn normalize_audio_for_transcript(
    app: &AppHandle,
    session: &LectureSession,
    task_id: Option<&str>,
) -> Result<()> {
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
            task_id,
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
        task_id,
    )?;

    Ok(())
}

pub fn prepare_sessions_on_startup(
    app: &AppHandle,
    sessions: &mut [LectureSession],
) -> Result<bool> {
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

        if session.mark_processing_interrupted(
            "Processing was interrupted because Leclog quit before the task finished.",
        ) {
            session.updated_at = chrono::Utc::now().to_rfc3339();
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

#[cfg(test)]
mod tests {
    use super::{
        normalize_processing_settings, parse_transcript_segments_with_finality,
        polish_transcript_text, render_json_export, render_lecture_notes_export, render_srt_export,
    };
    use crate::models::{
        CaptureSource, LectureSession, ProcessingQualityPreset, ProcessingSettings,
        SessionExportFormat, SessionExportRequest, SessionStatus, TranscriptExportLayer,
        TranscriptPhase, TranscriptSegment,
    };

    fn export_test_session() -> LectureSession {
        LectureSession {
            id: String::from("session-1"),
            title: String::from("Distributed Systems"),
            created_at: String::from("2026-05-28T00:00:00Z"),
            updated_at: String::from("2026-05-28T00:10:00Z"),
            capture_source: CaptureSource::ImportedMedia,
            status: SessionStatus::Done,
            duration_ms: 10_000,
            segments: vec![
                TranscriptSegment {
                    id: String::from("1"),
                    start_ms: 0,
                    end_ms: 2_500,
                    text: String::from("Welcome to the lecture."),
                    is_final: true,
                },
                TranscriptSegment {
                    id: String::from("2"),
                    start_ms: 2_500,
                    end_ms: 5_000,
                    text: String::from("We discuss consensus."),
                    is_final: true,
                },
            ],
            session_dir: Some(String::from("/tmp/session-1")),
            audio_file_paths: vec![String::from("/tmp/session-1/audio.wav")],
            active_audio_file_path: None,
            audio_mime_type: Some(String::from("audio/wav")),
            normalized_audio_path: Some(String::from("/tmp/session-1/normalized.wav")),
            processed_transcript_path: Some(String::from("/tmp/session-1/transcript.txt")),
            polished_transcript_path: Some(String::from("/tmp/session-1/transcript-polished.txt")),
            polished_transcript_text: Some(String::from(
                "Welcome to the lecture.\n\nWe discuss consensus.",
            )),
            live_preview_audio_path: None,
            live_preview_sample_rate: None,
            transcript_phase: TranscriptPhase::Ready,
            transcript_error: None,
            audio_level: None,
            last_resumed_at: None,
            capture_target_label: None,
            processing_settings: Some(ProcessingSettings::default()),
        }
    }

    fn export_request(format: SessionExportFormat) -> SessionExportRequest {
        SessionExportRequest {
            session_id: String::from("session-1"),
            format,
            layer: TranscriptExportLayer::Raw,
            include_metadata: true,
            include_timestamps: true,
            include_resource_paths: true,
            output_name: None,
        }
    }

    #[test]
    fn rewrites_whisper_cpp_json_into_sentence_segments() {
        let raw = r#"{
          "result": { "language": "ja" },
          "transcription": [
            {
              "offsets": { "from": 0, "to": 8500 },
              "text": "今日は授業を始めます"
            },
            {
              "offsets": { "from": 8500, "to": 12000 },
              "text": "よろしくお願いします"
            }
          ]
        }"#;

        let segments = parse_transcript_segments_with_finality(raw, true, None)
            .expect("segments should parse");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 8500);
        assert_eq!(segments[0].text, "今日は授業を始めます。");
        assert_eq!(segments[1].start_ms, 8500);
        assert_eq!(segments[1].end_ms, 12000);
        assert_eq!(segments[1].text, "よろしくお願いします。");
        assert!(segments.iter().all(|segment| segment.is_final));
    }

    #[test]
    fn merges_draft_segments_without_forcing_terminal_punctuation() {
        let raw = r#"{
          "result": { "language": "ja" },
          "transcription": [
            {
              "offsets": { "from": 0, "to": 4000 },
              "text": "次に"
            },
            {
              "offsets": { "from": 4000, "to": 9000 },
              "text": "分散システムについて"
            }
          ]
        }"#;

        let segments = parse_transcript_segments_with_finality(raw, false, None)
            .expect("segments should parse");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "次に分散システムについて");
        assert!(!segments[0].is_final);
    }

    #[test]
    fn builds_polished_transcript_paragraphs() {
        let polished = polish_transcript_text(&[
            TranscriptSegment {
                id: String::from("1"),
                start_ms: 0,
                end_ms: 1800,
                text: String::from("今日は授業を始めます。"),
                is_final: true,
            },
            TranscriptSegment {
                id: String::from("2"),
                start_ms: 1800,
                end_ms: 3600,
                text: String::from("まず前回の復習をします。"),
                is_final: true,
            },
            TranscriptSegment {
                id: String::from("3"),
                start_ms: 7600,
                end_ms: 9200,
                text: String::from("質問はありますか？"),
                is_final: true,
            },
        ]);

        assert_eq!(
            polished,
            "今日は授業を始めます。まず前回の復習をします。\n\n質問はありますか？"
        );
    }

    #[test]
    fn normalizes_balanced_processing_settings() {
        let settings = normalize_processing_settings(ProcessingSettings {
            quality_preset: ProcessingQualityPreset::Balanced,
            preferred_model_id: Some(String::from("  ggml-small.bin  ")),
            language: String::from(" ja "),
            prompt_terms: String::from("  lecture prompt  "),
            chunk_duration_minutes: 99,
            chunk_overlap_seconds: 999,
            whisper_threads: Some(99),
            max_parallel_chunks: 99,
            live_refresh_interval_seconds: 1,
        });

        assert_eq!(settings.quality_preset, ProcessingQualityPreset::Balanced);
        assert_eq!(
            settings.preferred_model_id.as_deref(),
            Some("ggml-small.bin")
        );
        assert_eq!(settings.language, "ja");
        assert_eq!(settings.prompt_terms, "lecture prompt");
        assert_eq!(settings.chunk_duration_minutes, 10);
        assert_eq!(settings.chunk_overlap_seconds, 20);
        assert_eq!(settings.whisper_threads, Some(16));
        assert_eq!(settings.max_parallel_chunks, 1);
        assert_eq!(settings.live_refresh_interval_seconds, 10);
    }

    #[test]
    fn preserves_custom_chunking_with_bounds() {
        let settings = normalize_processing_settings(ProcessingSettings {
            quality_preset: ProcessingQualityPreset::Custom,
            preferred_model_id: None,
            language: String::new(),
            prompt_terms: String::new(),
            chunk_duration_minutes: 0,
            chunk_overlap_seconds: 500,
            whisper_threads: Some(0),
            max_parallel_chunks: 8,
            live_refresh_interval_seconds: 60,
        });

        assert_eq!(settings.language, "auto");
        assert_eq!(settings.chunk_duration_minutes, 1);
        assert_eq!(settings.chunk_overlap_seconds, 120);
        assert_eq!(settings.whisper_threads, None);
        assert_eq!(settings.max_parallel_chunks, 4);
        assert_eq!(settings.live_refresh_interval_seconds, 60);
    }

    #[test]
    fn normalizes_common_language_aliases() {
        let settings = normalize_processing_settings(ProcessingSettings {
            quality_preset: ProcessingQualityPreset::Custom,
            preferred_model_id: None,
            language: String::from(" jp "),
            prompt_terms: String::new(),
            chunk_duration_minutes: 10,
            chunk_overlap_seconds: 20,
            whisper_threads: None,
            max_parallel_chunks: 1,
            live_refresh_interval_seconds: 4,
        });

        assert_eq!(settings.language, "ja");
    }

    #[test]
    fn renders_srt_caption_export() {
        let rendered = render_srt_export(&export_test_session()).expect("srt should render");

        assert!(rendered.starts_with("1\n00:00:00,000 --> 00:00:02,500\n"));
        assert!(rendered.contains("2\n00:00:02,500 --> 00:00:05,000\n"));
        assert!(rendered.contains("We discuss consensus."));
    }

    #[test]
    fn renders_json_export_with_schema_and_resources() {
        let session = export_test_session();
        let rendered = render_json_export(&session, &export_request(SessionExportFormat::Json))
            .expect("json should render");

        assert!(rendered.contains("\"schemaVersion\": 1"));
        assert!(rendered.contains("\"audioFilePaths\""));
        assert!(rendered.contains("\"Welcome to the lecture.\""));
    }

    #[test]
    fn renders_lecture_notes_template_with_transcript_appendix() {
        let session = export_test_session();
        let rendered = render_lecture_notes_export(
            &session,
            &export_request(SessionExportFormat::LectureNotes),
        )
        .expect("notes should render");

        assert!(rendered.contains("## Summary"));
        assert!(rendered.contains("## Key Points"));
        assert!(rendered.contains("## Transcript Appendix"));
        assert!(rendered.contains("We discuss consensus."));
    }
}
