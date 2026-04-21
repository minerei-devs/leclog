use std::{collections::HashMap, sync::Mutex};

use crate::models::LectureSession;
use crate::system_audio::SystemAudioCapture;

pub struct SessionState {
    sessions: Mutex<Vec<LectureSession>>,
}

impl SessionState {
    pub fn new(sessions: Vec<LectureSession>) -> Self {
        Self {
            sessions: Mutex::new(sessions),
        }
    }

    pub fn clone_sessions(&self) -> Result<Vec<LectureSession>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| String::from("Failed to acquire session state lock."))?;

        Ok(sessions.clone())
    }

    pub fn mutate<F, T>(&self, mutator: F) -> Result<(T, Vec<LectureSession>), String>
    where
        F: FnOnce(&mut Vec<LectureSession>) -> Result<T, String>,
    {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| String::from("Failed to acquire session state lock."))?;

        let result = mutator(&mut sessions)?;
        let snapshot = sessions.clone();
        Ok((result, snapshot))
    }
}

#[derive(Default)]
pub struct SystemAudioCaptureState {
    captures: Mutex<HashMap<String, SystemAudioCapture>>,
}

impl SystemAudioCaptureState {
    pub fn insert(&self, session_id: String, capture: SystemAudioCapture) -> Result<(), String> {
        let mut captures = self
            .captures
            .lock()
            .map_err(|_| String::from("Failed to acquire system audio capture lock."))?;
        captures.insert(session_id, capture);
        Ok(())
    }

    pub fn remove(&self, session_id: &str) -> Result<Option<SystemAudioCapture>, String> {
        let mut captures = self
            .captures
            .lock()
            .map_err(|_| String::from("Failed to acquire system audio capture lock."))?;
        Ok(captures.remove(session_id))
    }
}
