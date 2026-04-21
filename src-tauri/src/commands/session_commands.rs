use chrono::{DateTime, Utc};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    models::{CaptureSource, LectureSession, SessionStatus, TranscriptSegment},
    state::{SessionState, SystemAudioCaptureState},
    storage,
    system_audio::SystemAudioCapture,
};

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn default_title() -> String {
    format!("Lecture Session {}", Utc::now().format("%Y-%m-%d %H:%M"))
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| format!("Invalid timestamp in session state: {error}"))
}

fn effective_duration_ms(session: &LectureSession) -> Result<u64, String> {
    if session.status != SessionStatus::Recording {
        return Ok(session.duration_ms);
    }

    let Some(last_resumed_at) = session.last_resumed_at.as_deref() else {
        return Ok(session.duration_ms);
    };

    let elapsed = Utc::now()
        .signed_duration_since(parse_timestamp(last_resumed_at)?)
        .num_milliseconds()
        .max(0) as u64;

    Ok(session.duration_ms.saturating_add(elapsed))
}

fn present_session(session: &LectureSession) -> LectureSession {
    let mut snapshot = session.clone();
    if let Ok(duration_ms) = effective_duration_ms(session) {
        snapshot.duration_ms = snapshot.duration_ms.max(duration_ms);
    }
    snapshot
}

fn finalize_active_duration(session: &mut LectureSession) -> Result<(), String> {
    let Some(last_resumed_at) = session.last_resumed_at.take() else {
        return Ok(());
    };

    let elapsed = Utc::now()
        .signed_duration_since(parse_timestamp(&last_resumed_at)?)
        .num_milliseconds()
        .max(0) as u64;
    session.duration_ms = session.duration_ms.saturating_add(elapsed);
    Ok(())
}

fn persist_snapshot(app: &AppHandle, snapshot: &[LectureSession]) -> std::result::Result<(), String> {
    storage::persist_sessions(app, snapshot)
        .map_err(|error| format!("Failed to persist sessions: {error}"))
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    title: Option<String>,
    capture_source: Option<String>,
) -> Result<LectureSession, String> {
    let timestamp = now_iso();
    let mut session = LectureSession {
        id: Uuid::new_v4().to_string(),
        title: title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_title),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        capture_source: CaptureSource::parse(capture_source.as_deref())?,
        status: SessionStatus::Idle,
        duration_ms: 0,
        segments: Vec::new(),
        session_dir: None,
        audio_file_paths: Vec::new(),
        active_audio_file_path: None,
        audio_mime_type: None,
        normalized_audio_path: None,
        processed_transcript_path: None,
        live_preview_audio_path: None,
        live_preview_sample_rate: None,
        last_resumed_at: None,
        capture_target_label: None,
    };
    storage::ensure_session_paths(&app, &mut session)
        .map_err(|error| format!("Failed to initialize session storage: {error}"))?;

    let (created, snapshot) = state.mutate(|sessions| {
        sessions.push(session.clone());
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&created))
}

#[tauri::command]
pub fn list_sessions(state: State<'_, SessionState>) -> Result<Vec<LectureSession>, String> {
    let mut sessions = state.clone_sessions()?;
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions.iter().map(present_session).collect())
}

#[tauri::command]
pub fn get_session(id: String, state: State<'_, SessionState>) -> Result<LectureSession, String> {
    let sessions = state.clone_sessions()?;
    sessions
        .into_iter()
        .find(|session| session.id == id)
        .map(|session| present_session(&session))
        .ok_or_else(|| format!("Session with id {id} was not found."))
}

#[tauri::command]
pub fn append_segment(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    segment: TranscriptSegment,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Recording {
            return Err(String::from(
                "Transcript segments can only be appended while a session is recording.",
            ));
        }

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        session.updated_at = now_iso();
        session.segments.push(segment.clone());

        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn begin_audio_segment(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    mime_type: String,
    extension: String,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Recording {
            return Err(String::from(
                "Audio segments can only be started while a session is recording.",
            ));
        }

        storage::start_audio_segment(&app, session, &extension, &mime_type)
            .map_err(|error| format!("Failed to create the audio segment file: {error}"))?;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn append_audio_chunk(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let (_, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Recording {
            return Err(String::from(
                "Audio chunks can only be appended while a session is recording.",
            ));
        }

        storage::append_audio_chunk(session, &chunk)
            .map_err(|error| format!("Failed to persist audio chunk: {error}"))?;
        session.updated_at = now_iso();
        Ok(())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(())
}

#[tauri::command]
pub fn finish_audio_segment(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

        storage::finish_audio_segment(session);
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn initialize_live_preview(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    sample_rate: u32,
    reset: bool,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

        storage::initialize_live_preview_audio(&app, session, sample_rate, reset)
            .map_err(|error| format!("Failed to initialize live preview audio: {error}"))?;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn append_live_preview_chunk(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.clone_sessions()?;
    let session = sessions
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

    if session.status != SessionStatus::Recording && session.status != SessionStatus::Paused {
        return Err(String::from(
            "Live preview audio can only be appended for recording or paused sessions.",
        ));
    }

    storage::append_live_preview_chunk(&session, &chunk)
        .map_err(|error| format!("Failed to append live preview audio: {error}"))?;
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn refresh_live_transcript(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let current = get_session(session_id.clone(), state.clone())?;
    if current.status != SessionStatus::Recording && current.status != SessionStatus::Paused {
        return Ok(current);
    }

    let live_segments = storage::transcribe_live_preview_audio(&app, &current)
        .map_err(|error| format!("Failed to refresh the live transcript: {error}"))?;
    if live_segments.is_empty() {
        return Ok(current);
    }

    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        session.segments = live_segments.clone();
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn set_session_status(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    status: String,
) -> Result<LectureSession, String> {
    let next_status = SessionStatus::parse(&status)?;
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;

        if session.status == SessionStatus::Recording && next_status != SessionStatus::Recording {
            finalize_active_duration(session)?;
        }
        if session.status != SessionStatus::Recording && next_status == SessionStatus::Recording {
            session.last_resumed_at = Some(now_iso());
        }
        if next_status != SessionStatus::Recording {
            session.last_resumed_at = None;
        }

        session.status = next_status.clone();
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub async fn start_session_recording(
    app: AppHandle,
    state: State<'_, SessionState>,
    capture_state: State<'_, SystemAudioCaptureState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Idle {
            return Err(String::from("Only idle sessions can be started."));
        }

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        if session.capture_source == CaptureSource::SystemAudio {
            storage::initialize_live_preview_audio(&app, session, 48_000, true)
                .map_err(|error| format!("Failed to initialize live preview audio: {error}"))?;
            storage::start_audio_segment(&app, session, "mp4", "video/mp4")
                .map_err(|error| format!("Failed to prepare the system audio capture file: {error}"))?;
        }
        session.status = SessionStatus::Recording;
        session.last_resumed_at = Some(now_iso());
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    if updated.capture_source != CaptureSource::SystemAudio {
        persist_snapshot(&app, &snapshot)?;
        return Ok(present_session(&updated));
    }

    match SystemAudioCapture::start(&updated).await {
        Ok(started) => {
            capture_state
                .insert(updated.id.clone(), started.capture)
                .map_err(|error| format!("Failed to track the system audio capture: {error}"))?;
            let (capturing, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
                session.capture_target_label = Some(started.target_label);
                session.updated_at = now_iso();
                Ok(session.clone())
            })?;
            persist_snapshot(&app, &snapshot)?;
            Ok(present_session(&capturing))
        }
        Err(error) => {
            let (rolled_back, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
                storage::rollback_last_audio_segment(session)
                    .map_err(|rollback_error| {
                        format!("Failed to clean up the cancelled capture file: {rollback_error}")
                    })?;
                session.status = SessionStatus::Idle;
                session.last_resumed_at = None;
                session.updated_at = now_iso();
                Ok(session.clone())
            })?;
            persist_snapshot(&app, &snapshot)?;
            let _ = rolled_back;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn pause_session_recording(
    app: AppHandle,
    state: State<'_, SessionState>,
    capture_state: State<'_, SystemAudioCaptureState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let current = get_session(session_id.clone(), state.clone())?;
    if current.capture_source == CaptureSource::SystemAudio {
        let capture = capture_state
            .remove(&session_id)?
            .ok_or_else(|| String::from("No active system audio capture was found for this session."))?;
        capture.stop()?;
    }

    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Recording {
            return Err(String::from("Only recording sessions can be paused."));
        }

        finalize_active_duration(session)?;
        storage::finish_audio_segment(session);
        session.status = SessionStatus::Paused;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub async fn resume_session_recording(
    app: AppHandle,
    state: State<'_, SessionState>,
    capture_state: State<'_, SystemAudioCaptureState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Paused {
            return Err(String::from("Only paused sessions can be resumed."));
        }

        if session.capture_source == CaptureSource::SystemAudio {
            let sample_rate = session.live_preview_sample_rate.unwrap_or(48_000);
            storage::initialize_live_preview_audio(&app, session, sample_rate, false)
                .map_err(|error| format!("Failed to initialize live preview audio: {error}"))?;
            storage::start_audio_segment(&app, session, "mp4", "video/mp4")
                .map_err(|error| format!("Failed to prepare the system audio capture file: {error}"))?;
        }
        session.status = SessionStatus::Recording;
        session.last_resumed_at = Some(now_iso());
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    if updated.capture_source != CaptureSource::SystemAudio {
        persist_snapshot(&app, &snapshot)?;
        return Ok(present_session(&updated));
    }

    match SystemAudioCapture::start(&updated).await {
        Ok(started) => {
            capture_state
                .insert(updated.id.clone(), started.capture)
                .map_err(|error| format!("Failed to track the system audio capture: {error}"))?;
            let (capturing, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
                session.capture_target_label = Some(started.target_label);
                session.updated_at = now_iso();
                Ok(session.clone())
            })?;
            persist_snapshot(&app, &snapshot)?;
            Ok(present_session(&capturing))
        }
        Err(error) => {
            let (rolled_back, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
                storage::rollback_last_audio_segment(session)
                    .map_err(|rollback_error| {
                        format!("Failed to clean up the cancelled capture file: {rollback_error}")
                    })?;
                session.status = SessionStatus::Paused;
                session.last_resumed_at = None;
                session.updated_at = now_iso();
                Ok(session.clone())
            })?;
            persist_snapshot(&app, &snapshot)?;
            let _ = rolled_back;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn stop_session_recording(
    app: AppHandle,
    state: State<'_, SessionState>,
    capture_state: State<'_, SystemAudioCaptureState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let current = get_session(session_id.clone(), state.clone())?;
    if current.capture_source == CaptureSource::SystemAudio
        && current.status == SessionStatus::Recording
    {
        let capture = capture_state
            .remove(&session_id)?
            .ok_or_else(|| String::from("No active system audio capture was found for this session."))?;
        capture.stop()?;
    }

    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.status != SessionStatus::Recording && session.status != SessionStatus::Paused {
            return Err(String::from(
                "Only recording or paused sessions can be moved into processing.",
            ));
        }

        if session.status == SessionStatus::Recording {
            finalize_active_duration(session)?;
        }
        storage::finish_audio_segment(session);
        session.status = SessionStatus::Processing;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<(), String> {
    let (processing, _snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        session.updated_at = now_iso();
        session.last_resumed_at = None;
        Ok(session.clone())
    })?;
    storage::normalize_audio_for_transcript(&app, &processing)
        .map_err(|error| format!("Failed to normalize the recorded audio: {error}"))?;
    let transcribed_segments = storage::transcribe_normalized_audio(&app, &processing)
        .map_err(|error| format!("Failed to transcribe the recorded audio: {error}"))?;
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        session.segments = transcribed_segments.clone();
        if session.status == SessionStatus::Processing {
            session.status = SessionStatus::Done;
        }
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    storage::write_processed_transcript(&app, &updated)
        .map_err(|error| format!("Failed to write processed transcript: {error}"))?;
    persist_snapshot(&app, &snapshot)?;

    Ok(())
}
