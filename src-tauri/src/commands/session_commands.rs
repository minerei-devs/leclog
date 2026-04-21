use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::{
    models::{
        CaptureSource, LectureSession, ManagedTranscriptionModel, SessionStatus, TranscriptPhase,
        TranscriptSegment, TranscriptionModelInfo,
    },
    state::{
        AudioMeterState, ModelDownloadState, SessionState, SystemAudioCaptureState,
        TranscriptionTaskState,
    },
    storage,
    system_audio::SystemAudioCapture,
};

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn default_title() -> String {
    format!("Lecture Session {}", Utc::now().format("%Y-%m-%d %H:%M"))
}

fn imported_title(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_title)
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

fn present_session_with_meter(
    session: &LectureSession,
    audio_meter: Option<&State<'_, AudioMeterState>>,
) -> LectureSession {
    let mut snapshot = present_session(session);
    if let Some(audio_meter) = audio_meter {
        snapshot.audio_level = audio_meter.get(&snapshot.id).ok().flatten();
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

fn spawn_final_transcription_job(
    app: &AppHandle,
    session_id: &str,
    processing: LectureSession,
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
) {
    let app_handle = app.clone();
    let job_session_id = session_id.to_string();

    std::thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            storage::normalize_audio_for_transcript(&app_handle, &processing)
                .map_err(|error| format!("Failed to normalize the recorded audio: {error}"))?;
            let transcribed_segments = storage::transcribe_normalized_audio(
                &app_handle,
                &processing,
                preferred_model_id.as_deref(),
                preferred_language.as_deref(),
                prompt_terms.as_deref(),
            )
            .map_err(|error| format!("Failed to transcribe the recorded audio: {error}"))?;
            let polished_transcript_text = storage::polish_transcript_text(&transcribed_segments);
            let (updated, snapshot) = app_handle.state::<SessionState>().mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == job_session_id)
                    .ok_or_else(|| format!("Session with id {job_session_id} was not found."))?;
                session.segments = transcribed_segments.clone();
                session.polished_transcript_text = if polished_transcript_text.trim().is_empty() {
                    None
                } else {
                    Some(polished_transcript_text.clone())
                };
                if session.status == SessionStatus::Processing {
                    session.status = SessionStatus::Done;
                }
                if session.duration_ms == 0 {
                    session.duration_ms = session
                        .segments
                        .iter()
                        .map(|segment| segment.end_ms)
                        .max()
                        .unwrap_or(0);
                }
                session.transcript_phase = TranscriptPhase::Ready;
                session.transcript_error = None;
                session.updated_at = now_iso();
                Ok(session.clone())
            })?;
            storage::write_processed_transcript(&app_handle, &updated)
                .map_err(|error| format!("Failed to write processed transcript: {error}"))?;
            if updated.polished_transcript_text.is_some() {
                storage::write_polished_transcript(&app_handle, &updated)
                    .map_err(|error| format!("Failed to write polished transcript: {error}"))?;
            }
            persist_snapshot(&app_handle, &snapshot)?;
            Ok(())
        })();

        if let Err(error) = outcome {
            if let Ok((_, snapshot)) = app_handle.state::<SessionState>().mutate(|sessions| {
                if let Some(session) = sessions.iter_mut().find(|session| session.id == job_session_id)
                {
                    session.transcript_phase = TranscriptPhase::Error;
                    session.transcript_error = Some(error.clone());
                    session.updated_at = now_iso();
                }
                Ok(())
            }) {
                let _ = persist_snapshot(&app_handle, &snapshot);
            }
        }

        let _ = app_handle
            .state::<TranscriptionTaskState>()
            .finish_final(&job_session_id);
    });
}

#[tauri::command]
pub fn polish_session_transcript(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.segments.is_empty() {
            return Err(String::from("No transcript segments are available to polish."));
        }

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        let polished = storage::polish_transcript_text(&session.segments);
        if polished.trim().is_empty() {
            return Err(String::from("Transcript polishing did not produce any text."));
        }

        session.polished_transcript_text = Some(polished);
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    storage::write_processed_transcript(&app, &updated)
        .map_err(|error| format!("Failed to write processed transcript: {error}"))?;
    storage::write_polished_transcript(&app, &updated)
        .map_err(|error| format!("Failed to write polished transcript: {error}"))?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
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
        polished_transcript_path: None,
        polished_transcript_text: None,
        live_preview_audio_path: None,
        live_preview_sample_rate: None,
        transcript_phase: TranscriptPhase::Idle,
        transcript_error: None,
        audio_level: None,
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
pub fn import_media_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    tasks: State<'_, TranscriptionTaskState>,
    file_path: String,
    title: Option<String>,
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
) -> Result<LectureSession, String> {
    let timestamp = now_iso();
    let mut session = LectureSession {
        id: Uuid::new_v4().to_string(),
        title: title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| imported_title(&file_path)),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        capture_source: CaptureSource::ImportedMedia,
        status: SessionStatus::Processing,
        duration_ms: 0,
        segments: Vec::new(),
        session_dir: None,
        audio_file_paths: Vec::new(),
        active_audio_file_path: None,
        audio_mime_type: None,
        normalized_audio_path: None,
        processed_transcript_path: None,
        polished_transcript_path: None,
        polished_transcript_text: None,
        live_preview_audio_path: None,
        live_preview_sample_rate: None,
        transcript_phase: TranscriptPhase::Processing,
        transcript_error: None,
        audio_level: None,
        last_resumed_at: None,
        capture_target_label: None,
    };
    storage::ensure_session_paths(&app, &mut session)
        .map_err(|error| format!("Failed to initialize session storage: {error}"))?;
    storage::import_media_file(&app, &mut session, std::path::Path::new(&file_path))
        .map_err(|error| format!("Failed to import the media file: {error}"))?;

    let (created, snapshot) = state.mutate(|sessions| {
        sessions.push(session.clone());
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    if !tasks.try_start_final(&created.id)? {
        return Ok(present_session(&created));
    }

    spawn_final_transcription_job(
        &app,
        &created.id,
        created.clone(),
        preferred_model_id,
        preferred_language,
        prompt_terms,
    );

    Ok(present_session(&created))
}

#[tauri::command]
pub fn list_sessions(
    state: State<'_, SessionState>,
    audio_meter: State<'_, AudioMeterState>,
) -> Result<Vec<LectureSession>, String> {
    let mut sessions = state.clone_sessions()?;
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions
        .iter()
        .map(|session| present_session_with_meter(session, Some(&audio_meter)))
        .collect())
}

#[tauri::command]
pub fn get_session(
    id: String,
    state: State<'_, SessionState>,
    audio_meter: State<'_, AudioMeterState>,
) -> Result<LectureSession, String> {
    let sessions = state.clone_sessions()?;
    sessions
        .into_iter()
        .find(|session| session.id == id)
        .map(|session| present_session_with_meter(&session, Some(&audio_meter)))
        .ok_or_else(|| format!("Session with id {id} was not found."))
}

#[tauri::command]
pub fn list_transcription_models(app: AppHandle) -> Result<Vec<TranscriptionModelInfo>, String> {
    storage::list_transcription_models(&app)
        .map_err(|error| format!("Failed to list transcription models: {error}"))
}

#[tauri::command]
pub fn list_available_transcription_models(
    app: AppHandle,
    downloads: State<'_, ModelDownloadState>,
) -> Result<Vec<ManagedTranscriptionModel>, String> {
    let snapshot = downloads.snapshot()?;
    Ok(storage::list_available_transcription_models(&app, &snapshot))
}

#[tauri::command]
pub fn download_transcription_model(
    app: AppHandle,
    downloads: State<'_, ModelDownloadState>,
    model_id: String,
) -> Result<(), String> {
    let catalog_entry = storage::list_available_transcription_models(&app, &downloads.snapshot()?)
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| format!("Unsupported transcription model: {model_id}"))?;

    if catalog_entry.installed {
        downloads.upsert(catalog_entry)?;
        return Ok(());
    }

    if !downloads.start(catalog_entry.clone())? {
        return Ok(());
    }

    let app_handle = app.clone();
    let job_model_id = model_id.clone();
    std::thread::spawn(move || {
        let result = storage::download_transcription_model(&app_handle, &job_model_id, |downloaded_bytes, total_bytes| {
            app_handle
                .state::<ModelDownloadState>()
                .progress(&job_model_id, downloaded_bytes, total_bytes)
        });

        match result {
            Ok(path) => {
                let total_bytes = std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
                let _ = app_handle
                    .state::<ModelDownloadState>()
                    .complete(&job_model_id, path.display().to_string(), total_bytes);
            }
            Err(error) => {
                let _ = app_handle
                    .state::<ModelDownloadState>()
                    .fail(&job_model_id, error.to_string());
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn delete_transcription_model(
    app: AppHandle,
    downloads: State<'_, ModelDownloadState>,
    model_id: String,
) -> Result<(), String> {
    storage::delete_managed_transcription_model(&app, &model_id)
        .map_err(|error| format!("Failed to delete the local model: {error}"))?;
    downloads.clear(&model_id)?;
    Ok(())
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
    Ok(())
}

#[tauri::command]
pub fn queue_live_transcript_refresh(
    app: AppHandle,
    state: State<'_, SessionState>,
    audio_meter: State<'_, AudioMeterState>,
    tasks: State<'_, TranscriptionTaskState>,
    session_id: String,
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
) -> Result<LectureSession, String> {
    let current = get_session(session_id.clone(), state.clone(), audio_meter.clone())?;
    if current.status != SessionStatus::Recording && current.status != SessionStatus::Paused {
        return Ok(current);
    }

    if !tasks.try_start_live(&session_id)? {
        return Ok(current);
    }

    let (queued, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        session.transcript_phase = TranscriptPhase::Live;
        session.transcript_error = None;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    let app_handle = app.clone();
    let job_session_id = session_id.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            let state = app_handle.state::<SessionState>();
            let current = {
                let sessions = state.clone_sessions()?;
                sessions
                    .into_iter()
                    .find(|session| session.id == job_session_id)
                    .ok_or_else(|| format!("Session with id {job_session_id} was not found."))?
            };
            let live_segments = storage::transcribe_live_preview_audio(
                &app_handle,
                &current,
                preferred_model_id.as_deref(),
                preferred_language.as_deref(),
                prompt_terms.as_deref(),
            )
                .map_err(|error| format!("Failed to refresh the live transcript: {error}"))?;

            let (_, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|session| session.id == job_session_id)
                    .ok_or_else(|| format!("Session with id {job_session_id} was not found."))?;
                if !live_segments.is_empty() {
                    session.segments = live_segments.clone();
                }
                session.transcript_phase = TranscriptPhase::Live;
                session.transcript_error = None;
                session.updated_at = now_iso();
                Ok(())
            })?;
            persist_snapshot(&app_handle, &snapshot)?;
            Ok(())
        })();

        if let Err(error) = outcome {
            if let Ok((_, snapshot)) = app_handle.state::<SessionState>().mutate(|sessions| {
                if let Some(session) = sessions.iter_mut().find(|session| session.id == job_session_id)
                {
                    session.transcript_phase = TranscriptPhase::Error;
                    session.transcript_error = Some(error.clone());
                    session.updated_at = now_iso();
                }
                Ok(())
            }) {
                let _ = persist_snapshot(&app_handle, &snapshot);
            }
        }

        let _ = app_handle
            .state::<TranscriptionTaskState>()
            .finish_live(&job_session_id);
    });

    Ok(present_session(&queued))
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
        session.transcript_phase = TranscriptPhase::Live;
        session.transcript_error = None;
        session.last_resumed_at = Some(now_iso());
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    if updated.capture_source != CaptureSource::SystemAudio {
        persist_snapshot(&app, &snapshot)?;
        return Ok(present_session(&updated));
    }

    match SystemAudioCapture::start(&app, &updated).await {
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
    audio_meter: State<'_, AudioMeterState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let current = get_session(
        session_id.clone(),
        state.clone(),
        app.state::<AudioMeterState>(),
    )?;
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
    let _ = audio_meter.remove(&session_id);

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
        session.transcript_phase = TranscriptPhase::Live;
        session.transcript_error = None;
        session.last_resumed_at = Some(now_iso());
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    if updated.capture_source != CaptureSource::SystemAudio {
        persist_snapshot(&app, &snapshot)?;
        return Ok(present_session(&updated));
    }

    match SystemAudioCapture::start(&app, &updated).await {
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
    audio_meter: State<'_, AudioMeterState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let current = get_session(
        session_id.clone(),
        state.clone(),
        app.state::<AudioMeterState>(),
    )?;
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
        session.transcript_phase = TranscriptPhase::Processing;
        session.transcript_error = None;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;
    let _ = audio_meter.remove(&session_id);

    Ok(present_session(&updated))
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    tasks: State<'_, TranscriptionTaskState>,
    session_id: String,
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
) -> Result<(), String> {
    if !tasks.try_start_final(&session_id)? {
        return Ok(());
    }

    let (processing, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        session.updated_at = now_iso();
        session.last_resumed_at = None;
        session.transcript_phase = TranscriptPhase::Processing;
        session.transcript_error = None;
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    spawn_final_transcription_job(
        &app,
        &session_id,
        processing,
        preferred_model_id,
        preferred_language,
        prompt_terms,
    );

    Ok(())
}
