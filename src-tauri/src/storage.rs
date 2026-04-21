use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::models::LectureSession;

const SESSIONS_FILE_NAME: &str = "sessions.json";

fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("The sessions path must have a parent directory.")?;
    fs::create_dir_all(parent).context("Failed to create the application data directory.")?;
    Ok(())
}

pub fn sessions_file_path(app: &AppHandle) -> Result<PathBuf> {
    let base_dir = app
        .path()
        .app_local_data_dir()
        .context("Failed to resolve the local app data directory.")?;

    Ok(base_dir.join(SESSIONS_FILE_NAME))
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
    Ok(())
}
