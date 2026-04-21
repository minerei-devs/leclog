use std::sync::Mutex;

use crate::models::LectureSession;

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
