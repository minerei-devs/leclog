use std::{
    env,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::models::{LectureSession, SessionStatus};

const SESSIONS_FILE_NAME: &str = "sessions.json";
const SESSIONS_DIR_NAME: &str = "sessions";
const SESSION_METADATA_FILE_NAME: &str = "session.json";
const CONCAT_INPUTS_FILE_NAME: &str = "concat-inputs.txt";
const NORMALIZED_AUDIO_FILE_NAME: &str = "normalized.wav";
const PROCESSED_TRANSCRIPT_FILE_NAME: &str = "transcript.txt";

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

fn normalized_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(NORMALIZED_AUDIO_FILE_NAME))
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
