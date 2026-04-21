use chrono::Utc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    models::{LectureSession, SessionStatus, TranscriptSegment},
    state::SessionState,
    storage,
};

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn default_title() -> String {
    format!("Lecture Session {}", Utc::now().format("%Y-%m-%d %H:%M"))
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
) -> Result<LectureSession, String> {
    let timestamp = now_iso();
    let session = LectureSession {
        id: Uuid::new_v4().to_string(),
        title: title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_title),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        status: SessionStatus::Idle,
        duration_ms: 0,
        segments: Vec::new(),
    };

    let (created, snapshot) = state.mutate(|sessions| {
        sessions.push(session.clone());
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(created)
}

#[tauri::command]
pub fn list_sessions(state: State<'_, SessionState>) -> Result<Vec<LectureSession>, String> {
    let mut sessions = state.clone_sessions()?;
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn get_session(id: String, state: State<'_, SessionState>) -> Result<LectureSession, String> {
    let sessions = state.clone_sessions()?;
    sessions
        .into_iter()
        .find(|session| session.id == id)
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

        session.duration_ms = session.duration_ms.max(segment.end_ms);
        session.updated_at = now_iso();
        session.segments.push(segment.clone());

        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(updated)
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

        session.status = next_status.clone();
        session.updated_at = now_iso();
        Ok(session.clone())
    })?;
    persist_snapshot(&app, &snapshot)?;

    Ok(updated)
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    session_id: String,
) -> Result<(), String> {
    let sessions = state.clone_sessions()?;
    let exists = sessions.iter().any(|session| session.id == session_id);
    if !exists {
        return Err(format!("Session with id {session_id} was not found."));
    }

    persist_snapshot(&app, &sessions)?;
    Ok(())
}
