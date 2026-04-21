use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

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

#[derive(Default)]
pub struct AudioMeterState {
    levels: Mutex<HashMap<String, f32>>,
}

impl AudioMeterState {
    pub fn set(&self, session_id: &str, level: f32) -> Result<(), String> {
        let mut levels = self
            .levels
            .lock()
            .map_err(|_| String::from("Failed to acquire audio meter lock."))?;
        levels.insert(session_id.to_string(), level);
        Ok(())
    }

    pub fn get(&self, session_id: &str) -> Result<Option<f32>, String> {
        let levels = self
            .levels
            .lock()
            .map_err(|_| String::from("Failed to acquire audio meter lock."))?;
        Ok(levels.get(session_id).copied())
    }

    pub fn remove(&self, session_id: &str) -> Result<(), String> {
        let mut levels = self
            .levels
            .lock()
            .map_err(|_| String::from("Failed to acquire audio meter lock."))?;
        levels.remove(session_id);
        Ok(())
    }
}

#[derive(Default)]
pub struct TranscriptionTaskState {
    live_jobs: Mutex<HashSet<String>>,
    final_jobs: Mutex<HashSet<String>>,
}

impl TranscriptionTaskState {
    pub fn try_start_live(&self, session_id: &str) -> Result<bool, String> {
        let mut jobs = self
            .live_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire live transcription job lock."))?;
        Ok(jobs.insert(session_id.to_string()))
    }

    pub fn finish_live(&self, session_id: &str) -> Result<(), String> {
        let mut jobs = self
            .live_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire live transcription job lock."))?;
        jobs.remove(session_id);
        Ok(())
    }

    pub fn try_start_final(&self, session_id: &str) -> Result<bool, String> {
        let mut jobs = self
            .final_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription job lock."))?;
        Ok(jobs.insert(session_id.to_string()))
    }

    pub fn finish_final(&self, session_id: &str) -> Result<(), String> {
        let mut jobs = self
            .final_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription job lock."))?;
        jobs.remove(session_id);
        Ok(())
    }
}
