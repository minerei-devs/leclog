use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::{
    models::{
        BackgroundTask, BackgroundTaskKind, CaptureSource, LectureSession,
        ManagedTranscriptionModel, ProcessingQualityPreset, ProcessingSettings, ResourceItem,
        ResourceKind, ResourceOverview, RuntimeStatus, SessionStatus, TranscriptPhase,
        SessionSummary, TranscriptSegment, TranscriptionModelInfo,
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

fn summarize_session(
    session: &LectureSession,
    audio_meter: Option<&State<'_, AudioMeterState>>,
) -> SessionSummary {
    let duration_ms = effective_duration_ms(session)
        .map(|effective| session.duration_ms.max(effective))
        .unwrap_or(session.duration_ms);
    let audio_level = audio_meter.and_then(|meter| meter.get(&session.id).ok().flatten());

    SessionSummary {
        id: session.id.clone(),
        title: session.title.clone(),
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        capture_source: session.capture_source.clone(),
        status: session.status.clone(),
        duration_ms,
        transcript_phase: session.transcript_phase.clone(),
        transcript_error: session.transcript_error.clone(),
        audio_level,
        capture_target_label: session.capture_target_label.clone(),
        segment_count: session.segments.len(),
    }
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

fn fail_task_with_persisted_log(
    app: &AppHandle,
    task_state: &TranscriptionTaskState,
    task_id: &str,
    error: String,
) {
    let failure_log = storage::read_task_failure_log(app, task_id)
        .ok()
        .flatten()
        .or_else(|| storage::write_task_error_log(app, task_id, &error).ok());

    if let Ok(failed_task) = task_state.fail_task(task_id, error, failure_log) {
        let _ = storage::persist_failed_task(app, &failed_task);
    }
}

fn background_task_scope(task: &BackgroundTask) -> String {
    if let Some(session_id) = task.session_id.as_deref() {
        return format!("session:{session_id}");
    }
    if let Some(model_id) = task.model_id.as_deref() {
        return format!("model:{model_id}");
    }
    format!("task:{}", task.id)
}

fn mark_session_processing_interrupted(
    app: &AppHandle,
    session_id: &str,
    transcript_error: &str,
) -> std::result::Result<(), String> {
    let (changed, snapshot) = app.state::<SessionState>().mutate(|sessions| {
        let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) else {
            return Ok(false);
        };

        let changed = session.mark_processing_interrupted(transcript_error);
        if changed {
            session.updated_at = now_iso();
        }
        Ok(changed)
    })?;

    if changed {
        persist_snapshot(app, &snapshot)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn resolve_processing_settings(
    app: &AppHandle,
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
    quality_preset: Option<String>,
    chunk_duration_minutes: Option<u32>,
    chunk_overlap_seconds: Option<u32>,
    whisper_threads: Option<u32>,
    max_parallel_chunks: Option<u32>,
    live_refresh_interval_seconds: Option<u32>,
) -> ProcessingSettings {
    let mut settings = storage::load_processing_settings(app).unwrap_or_default();

    if let Some(quality_preset) = quality_preset {
        if let Ok(parsed) = ProcessingQualityPreset::parse(&quality_preset) {
            settings.quality_preset = parsed;
        }
    }
    if let Some(preferred_model_id) = preferred_model_id {
        settings.preferred_model_id = Some(preferred_model_id);
    }
    if let Some(preferred_language) = preferred_language {
        settings.language = preferred_language;
    }
    if let Some(prompt_terms) = prompt_terms {
        settings.prompt_terms = prompt_terms;
    }
    if let Some(chunk_duration_minutes) = chunk_duration_minutes {
        settings.chunk_duration_minutes = chunk_duration_minutes;
    }
    if let Some(chunk_overlap_seconds) = chunk_overlap_seconds {
        settings.chunk_overlap_seconds = chunk_overlap_seconds;
    }
    if let Some(whisper_threads) = whisper_threads {
        settings.whisper_threads = Some(whisper_threads);
    }
    if let Some(max_parallel_chunks) = max_parallel_chunks {
        settings.max_parallel_chunks = max_parallel_chunks;
    }
    if let Some(live_refresh_interval_seconds) = live_refresh_interval_seconds {
        settings.live_refresh_interval_seconds = live_refresh_interval_seconds;
    }

    storage::normalize_processing_settings(settings)
}

pub(crate) fn spawn_final_transcription_job(
    app: &AppHandle,
    session_id: &str,
    processing: LectureSession,
    settings: ProcessingSettings,
    task: BackgroundTask,
) {
    let app_handle = app.clone();
    let job_session_id = session_id.to_string();
    let task_id = task.id.clone();

    std::thread::spawn(move || {
        let _ = storage::clear_session_task_failure(&app_handle, &job_session_id);
        loop {
            let task_state = app_handle.state::<TranscriptionTaskState>();
            if task_state.is_canceled(&task_id).unwrap_or(false) {
                let _ = task_state.cancel_task(&task_id);
                let _ = mark_session_processing_interrupted(
                    &app_handle,
                    &job_session_id,
                    "Transcription was canceled.",
                );
                let _ = task_state.finish_final(&job_session_id);
                return;
            }
            if task_state.try_acquire_final_worker(&task_id).unwrap_or(false) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        let outcome = (|| -> Result<(), String> {
            let task_state = app_handle.state::<TranscriptionTaskState>();
            task_state
                .start_task(&task_id, "Normalizing audio")
                .map_err(|error| format!("Failed to start transcription task: {error}"))?;
            task_state
                .progress_task(&task_id, "Normalizing audio", 8.0, None, None, None, None)
                .ok();
            storage::normalize_audio_for_transcript(&app_handle, &processing, Some(&task_id))
                .map_err(|error| format!("Failed to normalize the recorded audio: {error}"))?;
            task_state
                .progress_task(&task_id, "Transcribing chunks", 20.0, Some(0), Some(0), None, None)
                .ok();
            let transcribed_segments = storage::transcribe_normalized_audio_with_settings(
                &app_handle,
                &processing,
                &settings,
                Some(&task_id),
                |completed, total| {
                    let percent = if total == 0 {
                        20.0
                    } else {
                        20.0 + ((completed as f32 / total as f32) * 68.0)
                    };
                    app_handle
                        .state::<TranscriptionTaskState>()
                        .progress_task(
                            &task_id,
                            "Transcribing chunks",
                            percent,
                            Some(completed as u32),
                            Some(total as u32),
                            None,
                            None,
                        )
                },
            )
            .map_err(|error| format!("Failed to transcribe the recorded audio: {error}"))?;
            task_state
                .progress_task(&task_id, "Polishing transcript", 92.0, None, None, None, None)
                .ok();
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
            let _ = storage::clear_session_task_failure(&app_handle, &job_session_id);
            task_state
                .succeed_task(&task_id, "Transcript ready")
                .map_err(|error| format!("Failed to complete transcription task: {error}"))?;
            Ok(())
        })();

        if let Err(error) = outcome {
            let task_state = app_handle.state::<TranscriptionTaskState>();
            if task_state.is_canceled(&task_id).unwrap_or(false)
                || error.to_ascii_lowercase().contains("canceled")
            {
                let _ = task_state.cancel_task(&task_id);
                let _ = mark_session_processing_interrupted(
                    &app_handle,
                    &job_session_id,
                    "Transcription was canceled.",
                );
            } else {
                fail_task_with_persisted_log(&app_handle, &task_state, &task_id, error.clone());
                let _ = mark_session_processing_interrupted(
                    &app_handle,
                    &job_session_id,
                    &error,
                );
            }
        }

        let _ = app_handle
            .state::<TranscriptionTaskState>()
            .release_final_worker(&task_id);
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
    preferred_model_id: Option<String>,
    preferred_language: Option<String>,
    prompt_terms: Option<String>,
    quality_preset: Option<String>,
    chunk_duration_minutes: Option<u32>,
    chunk_overlap_seconds: Option<u32>,
    whisper_threads: Option<u32>,
    max_parallel_chunks: Option<u32>,
    live_refresh_interval_seconds: Option<u32>,
) -> Result<LectureSession, String> {
    let timestamp = now_iso();
    let settings = resolve_processing_settings(
        &app,
        preferred_model_id,
        preferred_language,
        prompt_terms,
        quality_preset,
        chunk_duration_minutes,
        chunk_overlap_seconds,
        whisper_threads,
        max_parallel_chunks,
        live_refresh_interval_seconds,
    );
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
        processing_settings: Some(settings),
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
pub fn update_session_title(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
    title: String,
) -> Result<LectureSession, String> {
    let next_title = title.trim().to_string();
    if next_title.is_empty() {
        return Err(String::from("Session title cannot be empty."));
    }

    let (updated, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

        session.title = next_title;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(present_session(&updated))
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
    quality_preset: Option<String>,
    chunk_duration_minutes: Option<u32>,
    chunk_overlap_seconds: Option<u32>,
    whisper_threads: Option<u32>,
    max_parallel_chunks: Option<u32>,
    live_refresh_interval_seconds: Option<u32>,
) -> Result<LectureSession, String> {
    let timestamp = now_iso();
    let settings = resolve_processing_settings(
        &app,
        preferred_model_id,
        preferred_language,
        prompt_terms,
        quality_preset,
        chunk_duration_minutes,
        chunk_overlap_seconds,
        whisper_threads,
        max_parallel_chunks,
        live_refresh_interval_seconds,
    );
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
        processing_settings: Some(settings.clone()),
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

    let Some(task) = tasks.start_final_task(
        &created.id,
        format!("Transcribe imported media: {}", created.title),
    )? else {
        return Ok(present_session(&created));
    };
    spawn_final_transcription_job(
        &app,
        &created.id,
        created.clone(),
        settings,
        task,
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
pub fn list_session_summaries(
    state: State<'_, SessionState>,
    audio_meter: State<'_, AudioMeterState>,
) -> Result<Vec<SessionSummary>, String> {
    state.read(|sessions| {
        let mut summaries = sessions
            .iter()
            .map(|session| summarize_session(session, Some(&audio_meter)))
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(summaries)
    })
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
    tasks: State<'_, TranscriptionTaskState>,
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

    if downloads
        .snapshot()?
        .get(&model_id)
        .is_some_and(|model| model.download_status == crate::models::ModelDownloadStatus::Downloading)
    {
        return Ok(());
    }

    let task = tasks.create_task(
        BackgroundTaskKind::ModelDownload,
        format!("Download model: {}", catalog_entry.label),
        None,
        Some(model_id.clone()),
        true,
    )?;
    let app_handle = app.clone();
    let job_model_id = model_id.clone();
    let task_id = task.id.clone();
    std::thread::spawn(move || {
        let _ = storage::clear_model_task_failure(&app_handle, &job_model_id);
        let task_state = app_handle.state::<TranscriptionTaskState>();
        let _ = task_state.start_task(&task_id, "Waiting for download slot");
        loop {
            if task_state.is_canceled(&task_id).unwrap_or(false) {
                let _ = task_state.cancel_task(&task_id);
                return;
            }

            let active_download_count = app_handle
                .state::<ModelDownloadState>()
                .snapshot()
                .map(|jobs| {
                    jobs.values()
                        .filter(|job| {
                            job.download_status
                                == crate::models::ModelDownloadStatus::Downloading
                        })
                        .count()
                })
                .unwrap_or(0);
            if active_download_count < 2 {
                match app_handle
                    .state::<ModelDownloadState>()
                    .start(catalog_entry.clone())
                {
                    Ok(true) => break,
                    Ok(false) => return,
                    Err(error) => {
                        fail_task_with_persisted_log(&app_handle, &task_state, &task_id, error);
                        return;
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        let _ = task_state.start_task(&task_id, "Downloading model");
        let result = storage::download_transcription_model(&app_handle, &job_model_id, |downloaded_bytes, total_bytes| {
            let task_state = app_handle.state::<TranscriptionTaskState>();
            if task_state.is_canceled(&task_id).unwrap_or(false) {
                return Err(String::from("Task canceled."));
            }
            let percent = total_bytes
                .filter(|total| *total > 0)
                .map(|total| ((downloaded_bytes as f32 / total as f32) * 100.0).clamp(0.0, 100.0))
                .unwrap_or(0.0);
            task_state
                .progress_task(
                    &task_id,
                    "Downloading model",
                    percent,
                    None,
                    None,
                    Some(downloaded_bytes),
                    Some(total_bytes),
                )
                .ok();
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
                let _ = storage::clear_model_task_failure(&app_handle, &job_model_id);
                let _ = app_handle
                    .state::<TranscriptionTaskState>()
                    .succeed_task(&task_id, "Model installed");
            }
            Err(error) => {
                let _ = app_handle
                    .state::<ModelDownloadState>()
                    .fail(&job_model_id, error.to_string());
                let task_state = app_handle.state::<TranscriptionTaskState>();
                if task_state.is_canceled(&task_id).unwrap_or(false)
                    || error.to_string().to_ascii_lowercase().contains("canceled")
                {
                    let _ = task_state.cancel_task(&task_id);
                } else {
                    fail_task_with_persisted_log(
                        &app_handle,
                        &task_state,
                        &task_id,
                        error.to_string(),
                    );
                }
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
    let _ = storage::clear_model_task_failure(&app, &model_id);
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
    quality_preset: Option<String>,
    chunk_duration_minutes: Option<u32>,
    chunk_overlap_seconds: Option<u32>,
    whisper_threads: Option<u32>,
    max_parallel_chunks: Option<u32>,
    live_refresh_interval_seconds: Option<u32>,
) -> Result<(), String> {
    let settings = resolve_processing_settings(
        &app,
        preferred_model_id,
        preferred_language,
        prompt_terms,
        quality_preset,
        chunk_duration_minutes,
        chunk_overlap_seconds,
        whisper_threads,
        max_parallel_chunks,
        live_refresh_interval_seconds,
    );
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
        session.processing_settings = Some(settings.clone());
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    let Some(task) = tasks.start_final_task(
        &session_id,
        format!("Transcribe session: {}", processing.title),
    )? else {
        return Ok(());
    };
    spawn_final_transcription_job(
        &app,
        &session_id,
        processing,
        settings,
        task,
    );

    Ok(())
}

fn command_available(path: &Path, help_arg: &str) -> bool {
    if path.exists() {
        return true;
    }

    Command::new(path)
        .arg(help_arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn parse_whisper_acceleration_log(log: &str) -> (bool, Option<String>) {
    let gpu_name = log.lines().find_map(|line| {
        line.split_once("GPU name:")
            .map(|(_, value)| value.trim())
            .filter(|value| !value.is_empty())
    });

    if log.contains("loaded MTL backend") || log.contains("ggml_metal_device_init") {
        return (
            true,
            Some(match gpu_name {
                Some(name) => format!("Metal GPU ({name})"),
                None => String::from("Metal GPU"),
            }),
        );
    }

    if log.contains("loaded CUDA backend") || log.contains("ggml_cuda") {
        return (true, Some(String::from("CUDA GPU")));
    }

    if log.contains("loaded Vulkan backend") || log.contains("ggml_vulkan") {
        return (true, Some(String::from("Vulkan GPU")));
    }

    (false, Some(String::from("CPU only")))
}

fn detect_whisper_acceleration(path: &Path, whisper_available: bool) -> (bool, Option<String>) {
    if !whisper_available {
        return (false, None);
    }

    Command::new(path)
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .map(|output| {
            let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
            log.push('\n');
            log.push_str(&String::from_utf8_lossy(&output.stderr));
            parse_whisper_acceleration_log(&log)
        })
        .unwrap_or((false, Some(String::from("Unknown"))))
}

#[tauri::command]
pub fn get_runtime_status(
    app: AppHandle,
    state: State<'_, SessionState>,
) -> Result<RuntimeStatus, String> {
    let app_data_dir = storage::app_data_dir(&app)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    let write_probe_path = app_data_dir.join(".leclog-write-check");
    let is_app_data_writable = fs::write(&write_probe_path, b"ok")
        .and_then(|_| fs::remove_file(&write_probe_path))
        .is_ok();
    let ffmpeg_path = storage::resolve_ffmpeg_path(&app);
    let whisper_cli_path = storage::resolve_whisper_cli_path(&app);
    let ffmpeg_available = command_available(&ffmpeg_path, "-version");
    let whisper_available = command_available(&whisper_cli_path, "--help");
    let (whisper_acceleration_available, whisper_acceleration_label) =
        detect_whisper_acceleration(&whisper_cli_path, whisper_available);
    let installed_models = storage::list_transcription_models(&app)
        .map_err(|error| format!("Failed to list transcription models: {error}"))?;
    let processing_session_count = state.read(|sessions| {
        Ok(sessions
            .iter()
            .filter(|session| session.status == SessionStatus::Processing)
            .count())
    })?;
    let partial_download_count = storage::list_partial_downloads(&app)
        .map(|partials| partials.len())
        .unwrap_or(0);
    let mut issues = Vec::new();

    if !is_app_data_writable {
        issues.push(String::from("App local data directory is not writable."));
    }
    if !ffmpeg_available {
        issues.push(String::from("ffmpeg is not available."));
    }
    if !whisper_available {
        issues.push(String::from("whisper-cli is not available."));
    }
    if installed_models.is_empty() {
        issues.push(String::from("No local Whisper model is installed."));
    }
    if partial_download_count > 0 {
        issues.push(format!("{partial_download_count} partial model download(s) remain."));
    }

    Ok(RuntimeStatus {
        app_data_dir: app_data_dir.display().to_string(),
        is_app_data_writable,
        ffmpeg_path: Some(ffmpeg_path.display().to_string()),
        ffmpeg_available,
        whisper_cli_path: Some(whisper_cli_path.display().to_string()),
        whisper_available,
        whisper_acceleration_available,
        whisper_acceleration_label,
        installed_model_count: installed_models.len(),
        installed_model_labels: installed_models
            .into_iter()
            .map(|model| model.label)
            .collect(),
        processing_session_count,
        partial_download_count,
        issues,
    })
}

fn resource_item(
    kind: ResourceKind,
    label: String,
    path: PathBuf,
    deletable: bool,
    session_id: Option<String>,
    model_id: Option<String>,
    updated_at: Option<String>,
) -> ResourceItem {
    let exists = path.exists();
    let size_bytes = storage::path_size_bytes(&path).unwrap_or(0);
    let path_value = path.display().to_string();

    ResourceItem {
        id: format!("{kind:?}:{path_value}"),
        kind,
        label,
        path: path_value,
        size_bytes,
        exists,
        revealable: exists,
        deletable: deletable && exists,
        session_id,
        model_id,
        updated_at,
    }
}

fn clear_deleted_session_resource(session: &mut LectureSession, path: &Path) -> bool {
    let matches_path = |value: &str| Path::new(value) == path;
    let original_audio_file_count = session.audio_file_paths.len();
    session.audio_file_paths.retain(|value| !matches_path(value));
    let mut matched = session.audio_file_paths.len() != original_audio_file_count;

    if session
        .active_audio_file_path
        .as_deref()
        .is_some_and(|value| matches_path(value))
    {
        session.active_audio_file_path = None;
        matched = true;
    }
    if session
        .normalized_audio_path
        .as_deref()
        .is_some_and(|value| matches_path(value))
    {
        session.normalized_audio_path = None;
        matched = true;
    }
    if session
        .live_preview_audio_path
        .as_deref()
        .is_some_and(|value| matches_path(value))
    {
        session.live_preview_audio_path = None;
        session.live_preview_sample_rate = None;
        matched = true;
    }
    if session
        .processed_transcript_path
        .as_deref()
        .is_some_and(|value| matches_path(value))
    {
        session.processed_transcript_path = None;
        matched = true;
    }
    if session
        .polished_transcript_path
        .as_deref()
        .is_some_and(|value| matches_path(value))
    {
        session.polished_transcript_path = None;
        session.polished_transcript_text = None;
        matched = true;
    }

    if session.audio_file_paths.is_empty() && session.active_audio_file_path.is_none() {
        session.audio_mime_type = None;
    }
    if matched {
        session.updated_at = now_iso();
    }

    matched
}

#[tauri::command]
pub fn delete_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    tasks: State<'_, TranscriptionTaskState>,
    capture_state: State<'_, SystemAudioCaptureState>,
    audio_meter: State<'_, AudioMeterState>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .clone_sessions()?
        .into_iter()
        .find(|candidate| candidate.id == session_id)
        .ok_or_else(|| format!("Session with id {session_id} was not found."))?;

    if session.status == SessionStatus::Recording {
        return Err(String::from(
            "Pause or stop recording before deleting this session.",
        ));
    }

    let app_data_dir = storage::app_data_dir(&app)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let fallback_session_dir = storage::session_dir_path(&app, &session_id)
        .map_err(|error| format!("Failed to resolve session directory: {error}"))?;
    let session_dir = session
        .session_dir
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .unwrap_or(fallback_session_dir);

    let _ = tasks.cancel_session_tasks(&session_id);
    let _ = capture_state.remove(&session_id);
    let _ = audio_meter.remove(&session_id);
    let _ = storage::clear_session_task_failure(&app, &session_id);

    if session_dir.exists() {
        if session_dir == app_data_dir {
            return Err(String::from(
                "The app data root cannot be deleted from here.",
            ));
        }
        if !storage::is_inside_app_data(&app, &session_dir)
            .map_err(|error| format!("Failed to validate session directory: {error}"))?
        {
            return Err(String::from(
                "Only Leclog app session directories can be deleted.",
            ));
        }
        fs::remove_dir_all(&session_dir)
            .map_err(|error| format!("Failed to delete session directory: {error}"))?;
    }

    let (_, snapshot) = state.mutate(|sessions| {
        let original_count = sessions.len();
        sessions.retain(|session| session.id != session_id);
        if sessions.len() == original_count {
            return Err(String::from("Session not found."));
        }
        Ok(())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(())
}

#[tauri::command]
pub fn list_resources(
    app: AppHandle,
    state: State<'_, SessionState>,
    downloads: State<'_, ModelDownloadState>,
) -> Result<ResourceOverview, String> {
    let app_data_dir = storage::app_data_dir(&app)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let sessions_dir = storage::sessions_root_dir(&app)
        .map_err(|error| format!("Failed to resolve sessions directory: {error}"))?;
    let models_dir = storage::app_models_dir(&app)
        .map_err(|error| format!("Failed to resolve models directory: {error}"))?;
    let mut resources = vec![resource_item(
        ResourceKind::AppData,
        String::from("App local data"),
        app_data_dir.clone(),
        false,
        None,
        None,
        None,
    )];
    let mut processed_bytes = 0u64;

    for session in state.clone_sessions()? {
        let Some(session_dir) = session.session_dir.as_ref().map(PathBuf::from) else {
            continue;
        };
        resources.push(resource_item(
            ResourceKind::SessionDir,
            session.title.clone(),
            session_dir.clone(),
            true,
            Some(session.id.clone()),
            None,
            Some(session.updated_at.clone()),
        ));

        for (index, path) in session.audio_file_paths.iter().enumerate() {
            resources.push(resource_item(
                ResourceKind::Audio,
                format!("{} capture {}", session.title, index + 1),
                PathBuf::from(path),
                false,
                Some(session.id.clone()),
                None,
                Some(session.updated_at.clone()),
            ));
        }

        for (kind, label, path) in [
            (
                ResourceKind::NormalizedAudio,
                "Normalized audio",
                session.normalized_audio_path.as_ref(),
            ),
            (
                ResourceKind::LivePreviewAudio,
                "Live preview audio",
                session.live_preview_audio_path.as_ref(),
            ),
            (
                ResourceKind::Transcript,
                "Processed transcript",
                session.processed_transcript_path.as_ref(),
            ),
            (
                ResourceKind::Transcript,
                "Polished transcript",
                session.polished_transcript_path.as_ref(),
            ),
        ] {
            if let Some(path) = path {
                let path = PathBuf::from(path);
                if matches!(kind, ResourceKind::NormalizedAudio | ResourceKind::LivePreviewAudio | ResourceKind::Transcript) {
                    processed_bytes = processed_bytes.saturating_add(storage::path_size_bytes(&path).unwrap_or(0));
                }
                resources.push(resource_item(
                    kind,
                    format!("{} {label}", session.title),
                    path,
                    false,
                    Some(session.id.clone()),
                    None,
                    Some(session.updated_at.clone()),
                ));
            }
        }
    }

    let download_snapshot = downloads.snapshot()?;
    for model in storage::list_available_transcription_models(&app, &download_snapshot) {
        if let Some(path) = model.installed_path.as_ref() {
            resources.push(resource_item(
                ResourceKind::Model,
                model.label,
                PathBuf::from(path),
                model.managed_by_app,
                None,
                Some(model.id),
                None,
            ));
        }
    }

    for partial in storage::list_partial_downloads(&app).unwrap_or_default() {
        resources.push(resource_item(
            ResourceKind::PartialDownload,
            partial
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Partial model download")
                .to_string(),
            partial,
            true,
            None,
            None,
            None,
        ));
    }

    let total_bytes = storage::path_size_bytes(&app_data_dir).unwrap_or(0);
    let session_bytes = storage::path_size_bytes(&sessions_dir).unwrap_or(0);
    let model_bytes = storage::path_size_bytes(&models_dir).unwrap_or(0);
    let temp_bytes = resources
        .iter()
        .filter(|resource| resource.kind == ResourceKind::PartialDownload)
        .map(|resource| resource.size_bytes)
        .sum();
    resources.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.label.cmp(&right.label)));

    Ok(ResourceOverview {
        app_data_dir: app_data_dir.display().to_string(),
        total_bytes,
        session_bytes,
        model_bytes,
        processed_bytes,
        temp_bytes,
        resources,
    })
}

#[tauri::command]
pub fn delete_resource(
    app: AppHandle,
    state: State<'_, SessionState>,
    downloads: State<'_, ModelDownloadState>,
    path: String,
    session_id: Option<String>,
    model_id: Option<String>,
) -> Result<ResourceOverview, String> {
    let path = PathBuf::from(path);
    let app_data_dir = storage::app_data_dir(&app)
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    if !storage::is_inside_app_data(&app, &path)
        .map_err(|error| format!("Failed to validate resource path: {error}"))?
    {
        return Err(String::from("Only Leclog app resources can be deleted."));
    }
    if path == app_data_dir {
        return Err(String::from("The app data root cannot be deleted from here."));
    }

    if let Some(model_id) = model_id.as_deref() {
        storage::delete_managed_transcription_model(&app, model_id)
            .map_err(|error| format!("Failed to delete model resource: {error}"))?;
        downloads.clear(model_id)?;
    } else if let Some(session_id) = session_id.as_deref() {
        let expected_session_dir = storage::session_dir_path(&app, session_id)
            .map_err(|error| format!("Failed to resolve session directory: {error}"))?;
        if path == expected_session_dir {
            if path.exists() {
                fs::remove_dir_all(&path)
                    .map_err(|error| format!("Failed to delete session directory: {error}"))?;
            }
            let (_, snapshot) = state.mutate(|sessions| {
                sessions.retain(|session| session.id != session_id);
                Ok(())
            })?;
            persist_snapshot(&app, &snapshot)?;
        } else {
            let canonical_session_dir = expected_session_dir
                .canonicalize()
                .map_err(|error| format!("Failed to validate session directory: {error}"))?;
            let canonical_path = path
                .canonicalize()
                .map_err(|error| format!("Failed to validate session resource: {error}"))?;
            if !canonical_path.starts_with(canonical_session_dir) || !canonical_path.is_file() {
                return Err(String::from("Only files inside this session can be deleted."));
            }
            let is_tracked_resource = state
                .clone_sessions()?
                .into_iter()
                .find(|candidate| candidate.id == session_id)
                .map(|mut session| clear_deleted_session_resource(&mut session, &path))
                .unwrap_or(false);
            if !is_tracked_resource {
                return Err(String::from("The selected file is not tracked by this session."));
            }

            fs::remove_file(&canonical_path)
                .map_err(|error| format!("Failed to delete session resource: {error}"))?;
            let (_, snapshot) = state.mutate(|sessions| {
                let session = sessions
                    .iter_mut()
                    .find(|candidate| candidate.id == session_id)
                    .ok_or_else(|| String::from("Session not found."))?;
                clear_deleted_session_resource(session, &path);
                Ok(())
            })?;
            persist_snapshot(&app, &snapshot)?;
        }
    } else if path.exists() && path.is_file() {
        fs::remove_file(&path).map_err(|error| format!("Failed to delete resource: {error}"))?;
    } else {
        return Err(String::from("Unsupported resource deletion request."));
    }

    list_resources(app, state, downloads)
}

#[tauri::command]
pub fn reveal_resource(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !storage::is_inside_app_data(&app, &path)
        .map_err(|error| format!("Failed to validate resource path: {error}"))?
    {
        return Err(String::from("Only Leclog app resources can be revealed."));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", path.to_string_lossy().as_ref()])
            .status()
            .map_err(|error| format!("Failed to reveal resource in Finder: {error}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .status()
            .map_err(|error| format!("Failed to reveal resource in Explorer: {error}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|error| format!("Failed to reveal resource: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn list_background_tasks(
    app: AppHandle,
    tasks: State<'_, TranscriptionTaskState>,
) -> Result<Vec<BackgroundTask>, String> {
    let mut current_tasks = tasks.list_tasks()?;
    let existing_ids = current_tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let active_scopes = current_tasks
        .iter()
        .filter(|task| {
            matches!(
                task.status,
                crate::models::BackgroundTaskStatus::Queued
                    | crate::models::BackgroundTaskStatus::Running
            )
        })
        .map(background_task_scope)
        .collect::<HashSet<_>>();

    for persisted_task in storage::list_persisted_failed_tasks(&app)
        .map_err(|error| format!("Failed to list persisted task failures: {error}"))?
    {
        if existing_ids.contains(&persisted_task.id) {
            continue;
        }
        if active_scopes.contains(&background_task_scope(&persisted_task)) {
            continue;
        }
        current_tasks.push(persisted_task);
    }

    current_tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(current_tasks)
}

#[tauri::command]
pub fn cancel_background_task(
    app: AppHandle,
    tasks: State<'_, TranscriptionTaskState>,
    task_id: String,
) -> Result<BackgroundTask, String> {
    let task = tasks.cancel_task(&task_id)?;
    if let Some(session_id) = task.session_id.as_deref() {
        let _ = mark_session_processing_interrupted(
            &app,
            session_id,
            "Transcription was canceled.",
        );
    }
    Ok(task)
}

#[tauri::command]
pub fn retry_session_processing(
    app: AppHandle,
    state: State<'_, SessionState>,
    tasks: State<'_, TranscriptionTaskState>,
    session_id: String,
) -> Result<LectureSession, String> {
    let (processing, snapshot) = state.mutate(|sessions| {
        let session = sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| format!("Session with id {session_id} was not found."))?;
        if session.audio_file_paths.is_empty() {
            return Err(String::from("This session does not have any audio files to process."));
        }

        storage::ensure_session_paths(&app, session)
            .map_err(|error| format!("Failed to prepare session storage: {error}"))?;
        session.status = SessionStatus::Processing;
        session.transcript_phase = TranscriptPhase::Processing;
        session.transcript_error = None;
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    let Some(task) = tasks.start_final_task(
        &session_id,
        format!("Retry transcription: {}", processing.title),
    )? else {
        return Ok(present_session(&processing));
    };
    let settings = processing
        .processing_settings
        .clone()
        .unwrap_or_else(|| storage::load_processing_settings(&app).unwrap_or_default());
    spawn_final_transcription_job(&app, &session_id, processing.clone(), settings, task);

    Ok(present_session(&processing))
}

#[tauri::command]
pub fn get_processing_settings(app: AppHandle) -> Result<ProcessingSettings, String> {
    storage::load_processing_settings(&app)
        .map_err(|error| format!("Failed to load processing settings: {error}"))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn patch_processing_settings(
    app: AppHandle,
    quality_preset: Option<String>,
    preferred_model_id: Option<String>,
    clear_preferred_model_id: Option<bool>,
    language: Option<String>,
    prompt_terms: Option<String>,
    chunk_duration_minutes: Option<u32>,
    chunk_overlap_seconds: Option<u32>,
    whisper_threads: Option<u32>,
    clear_whisper_threads: Option<bool>,
    max_parallel_chunks: Option<u32>,
    live_refresh_interval_seconds: Option<u32>,
) -> Result<ProcessingSettings, String> {
    let mut settings = storage::load_processing_settings(&app).unwrap_or_default();
    if let Some(quality_preset) = quality_preset {
        settings.quality_preset = ProcessingQualityPreset::parse(&quality_preset)?;
    }
    if clear_preferred_model_id.unwrap_or(false) {
        settings.preferred_model_id = None;
    } else if let Some(preferred_model_id) = preferred_model_id {
        settings.preferred_model_id = Some(preferred_model_id);
    }
    if let Some(language) = language {
        settings.language = language;
    }
    if let Some(prompt_terms) = prompt_terms {
        settings.prompt_terms = prompt_terms;
    }
    if let Some(chunk_duration_minutes) = chunk_duration_minutes {
        settings.chunk_duration_minutes = chunk_duration_minutes;
    }
    if let Some(chunk_overlap_seconds) = chunk_overlap_seconds {
        settings.chunk_overlap_seconds = chunk_overlap_seconds;
    }
    if clear_whisper_threads.unwrap_or(false) {
        settings.whisper_threads = None;
    } else if let Some(whisper_threads) = whisper_threads {
        settings.whisper_threads = Some(whisper_threads);
    }
    if let Some(max_parallel_chunks) = max_parallel_chunks {
        settings.max_parallel_chunks = max_parallel_chunks;
    }
    if let Some(live_refresh_interval_seconds) = live_refresh_interval_seconds {
        settings.live_refresh_interval_seconds = live_refresh_interval_seconds;
    }

    let settings = storage::normalize_processing_settings(settings);
    storage::persist_processing_settings(&app, &settings)
        .map_err(|error| format!("Failed to save processing settings: {error}"))?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session() -> LectureSession {
        LectureSession {
            id: String::from("session-1"),
            title: String::from("Session"),
            created_at: String::from("2026-05-12T00:00:00Z"),
            updated_at: String::from("2026-05-12T00:00:00Z"),
            capture_source: CaptureSource::Microphone,
            status: SessionStatus::Done,
            duration_ms: 0,
            segments: Vec::new(),
            session_dir: Some(String::from("/tmp/session-1")),
            audio_file_paths: vec![String::from("/tmp/session-1/audio/segment-001.wav")],
            active_audio_file_path: Some(String::from("/tmp/session-1/audio/segment-001.wav")),
            audio_mime_type: Some(String::from("audio/wav")),
            normalized_audio_path: Some(String::from("/tmp/session-1/processed/normalized.wav")),
            processed_transcript_path: Some(String::from("/tmp/session-1/processed/transcript.txt")),
            polished_transcript_path: Some(String::from("/tmp/session-1/processed/transcript-polished.txt")),
            polished_transcript_text: Some(String::from("Polished")),
            live_preview_audio_path: Some(String::from("/tmp/session-1/processed/live-preview.wav")),
            live_preview_sample_rate: Some(16_000),
            transcript_phase: TranscriptPhase::Ready,
            transcript_error: None,
            audio_level: None,
            last_resumed_at: None,
            capture_target_label: None,
            processing_settings: None,
        }
    }

    #[test]
    fn clears_deleted_audio_metadata() {
        let mut session = test_session();

        let matched = clear_deleted_session_resource(
            &mut session,
            Path::new("/tmp/session-1/audio/segment-001.wav"),
        );

        assert!(matched);
        assert!(session.audio_file_paths.is_empty());
        assert!(session.active_audio_file_path.is_none());
        assert!(session.audio_mime_type.is_none());
    }

    #[test]
    fn clears_deleted_polished_transcript_payload() {
        let mut session = test_session();

        let matched = clear_deleted_session_resource(
            &mut session,
            Path::new("/tmp/session-1/processed/transcript-polished.txt"),
        );

        assert!(matched);
        assert!(session.polished_transcript_path.is_none());
        assert!(session.polished_transcript_text.is_none());
    }

    #[test]
    fn ignores_untracked_session_resource() {
        let mut session = test_session();

        let matched = clear_deleted_session_resource(
            &mut session,
            Path::new("/tmp/session-1/processed/unknown.tmp"),
        );

        assert!(!matched);
        assert!(session.normalized_audio_path.is_some());
        assert!(session.polished_transcript_text.is_some());
    }

    #[test]
    fn detects_metal_whisper_acceleration() {
        let (available, label) = parse_whisper_acceleration_log(
            "ggml_metal_device_init: GPU name:   MTL0\nload_backend: loaded MTL backend",
        );

        assert!(available);
        assert_eq!(label.as_deref(), Some("Metal GPU (MTL0)"));
    }

    #[test]
    fn reports_cpu_only_whisper_acceleration() {
        let (available, label) =
            parse_whisper_acceleration_log("load_backend: loaded CPU backend");

        assert!(!available);
        assert_eq!(label.as_deref(), Some("CPU only"));
    }
}
