use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

use chrono::Utc;
use uuid::Uuid;

use crate::models::{
    BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, LectureSession,
    ManagedTranscriptionModel, ModelDownloadStatus, TaskFailureLog,
};
use crate::system_audio::SystemAudioCapture;

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

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

    pub fn read<F, T>(&self, reader: F) -> Result<T, String>
    where
        F: FnOnce(&[LectureSession]) -> Result<T, String>,
    {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| String::from("Failed to acquire session state lock."))?;

        reader(&sessions)
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
    final_jobs: Mutex<HashMap<String, String>>,
    final_worker: Mutex<Option<String>>,
    tasks: Mutex<HashMap<String, BackgroundTask>>,
    canceled_tasks: Mutex<HashSet<String>>,
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

    pub fn start_final_task(
        &self,
        session_id: &str,
        title: String,
    ) -> Result<Option<BackgroundTask>, String> {
        let mut jobs = self
            .final_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription job lock."))?;
        if jobs.contains_key(session_id) {
            return Ok(None);
        }

        let task = self.create_task_locked(
            BackgroundTaskKind::FinalTranscription,
            title,
            Some(session_id.to_string()),
            None,
            true,
        )?;
        jobs.insert(session_id.to_string(), task.id.clone());
        Ok(Some(task))
    }

    pub fn finish_final(&self, session_id: &str) -> Result<(), String> {
        let mut jobs = self
            .final_jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription job lock."))?;
        jobs.remove(session_id);
        Ok(())
    }

    pub fn try_acquire_final_worker(&self, task_id: &str) -> Result<bool, String> {
        let mut worker = self
            .final_worker
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription worker lock."))?;
        if worker.is_none() {
            *worker = Some(task_id.to_string());
            return Ok(true);
        }
        Ok(worker.as_deref() == Some(task_id))
    }

    pub fn release_final_worker(&self, task_id: &str) -> Result<(), String> {
        let mut worker = self
            .final_worker
            .lock()
            .map_err(|_| String::from("Failed to acquire final transcription worker lock."))?;
        if worker.as_deref() == Some(task_id) {
            *worker = None;
        }
        Ok(())
    }

    pub fn create_task(
        &self,
        kind: BackgroundTaskKind,
        title: String,
        session_id: Option<String>,
        model_id: Option<String>,
        cancelable: bool,
    ) -> Result<BackgroundTask, String> {
        self.create_task_locked(kind, title, session_id, model_id, cancelable)
    }

    fn create_task_locked(
        &self,
        kind: BackgroundTaskKind,
        title: String,
        session_id: Option<String>,
        model_id: Option<String>,
        cancelable: bool,
    ) -> Result<BackgroundTask, String> {
        let timestamp = now_iso();
        let task = BackgroundTask {
            id: Uuid::new_v4().to_string(),
            kind,
            status: BackgroundTaskStatus::Queued,
            title,
            step: String::from("Queued"),
            percent: 0.0,
            completed_chunks: 0,
            total_chunks: 0,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            failure_log: None,
            session_id,
            model_id,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            cancelable,
        };

        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire background task lock."))?;
        tasks.insert(task.id.clone(), task.clone());
        Ok(task)
    }

    pub fn list_tasks(&self) -> Result<Vec<BackgroundTask>, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire background task lock."))?;
        let mut values = tasks.values().cloned().collect::<Vec<_>>();
        values.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(values)
    }

    pub fn start_task(&self, task_id: &str, step: &str) -> Result<(), String> {
        self.update_task(task_id, |task| {
            task.status = BackgroundTaskStatus::Running;
            task.step = step.to_string();
            task.error = None;
        })
    }

    pub fn progress_task(
        &self,
        task_id: &str,
        step: &str,
        percent: f32,
        completed_chunks: Option<u32>,
        total_chunks: Option<u32>,
        downloaded_bytes: Option<u64>,
        total_bytes: Option<Option<u64>>,
    ) -> Result<(), String> {
        self.update_task(task_id, |task| {
            task.status = BackgroundTaskStatus::Running;
            task.step = step.to_string();
            task.percent = percent.clamp(0.0, 100.0);
            if let Some(completed_chunks) = completed_chunks {
                task.completed_chunks = completed_chunks;
            }
            if let Some(total_chunks) = total_chunks {
                task.total_chunks = total_chunks;
            }
            if let Some(downloaded_bytes) = downloaded_bytes {
                task.downloaded_bytes = downloaded_bytes;
            }
            if let Some(total_bytes) = total_bytes {
                task.total_bytes = total_bytes;
            }
            task.error = None;
            task.failure_log = None;
        })
    }

    pub fn succeed_task(&self, task_id: &str, step: &str) -> Result<(), String> {
        self.update_task(task_id, |task| {
            task.status = BackgroundTaskStatus::Succeeded;
            task.step = step.to_string();
            task.percent = 100.0;
            task.error = None;
            task.failure_log = None;
            task.cancelable = false;
        })?;
        self.clear_cancellation(task_id)
    }

    pub fn fail_task(
        &self,
        task_id: &str,
        error: String,
        failure_log: Option<TaskFailureLog>,
    ) -> Result<BackgroundTask, String> {
        self.update_task(task_id, |task| {
            task.status = BackgroundTaskStatus::Failed;
            task.step = String::from("Failed");
            task.error = Some(error);
            task.failure_log = failure_log;
            task.cancelable = false;
        })?;
        self.clear_cancellation(task_id)?;
        self.get_task(task_id)
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<BackgroundTask, String> {
        {
            let mut canceled = self
                .canceled_tasks
                .lock()
                .map_err(|_| String::from("Failed to acquire task cancellation lock."))?;
            canceled.insert(task_id.to_string());
        }

        self.update_task(task_id, |task| {
            task.status = BackgroundTaskStatus::Canceled;
            task.step = String::from("Canceling");
            task.error = None;
            task.failure_log = None;
            task.cancelable = false;
        })?;

        self.get_task(task_id)
    }

    pub fn cancel_session_tasks(&self, session_id: &str) -> Result<Vec<BackgroundTask>, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire background task lock."))?;
        let mut canceled = self
            .canceled_tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire task cancellation lock."))?;
        let timestamp = now_iso();
        let mut canceled_tasks = Vec::new();

        for task in tasks.values_mut().filter(|task| {
            task.session_id.as_deref() == Some(session_id)
                && matches!(
                    task.status,
                    BackgroundTaskStatus::Queued | BackgroundTaskStatus::Running
                )
        }) {
            canceled.insert(task.id.clone());
            task.status = BackgroundTaskStatus::Canceled;
            task.step = String::from("Canceling");
            task.error = None;
            task.failure_log = None;
            task.cancelable = false;
            task.updated_at = timestamp.clone();
            canceled_tasks.push(task.clone());
        }
        drop(canceled);
        drop(tasks);

        {
            let mut live_jobs = self
                .live_jobs
                .lock()
                .map_err(|_| String::from("Failed to acquire live transcription job lock."))?;
            live_jobs.remove(session_id);
        }

        Ok(canceled_tasks)
    }

    pub fn is_canceled(&self, task_id: &str) -> Result<bool, String> {
        let canceled = self
            .canceled_tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire task cancellation lock."))?;
        Ok(canceled.contains(task_id))
    }

    fn clear_cancellation(&self, task_id: &str) -> Result<(), String> {
        let mut canceled = self
            .canceled_tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire task cancellation lock."))?;
        canceled.remove(task_id);
        Ok(())
    }

    fn get_task(&self, task_id: &str) -> Result<BackgroundTask, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire background task lock."))?;
        tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| format!("Background task with id {task_id} was not found."))
    }

    fn update_task<F>(&self, task_id: &str, updater: F) -> Result<(), String>
    where
        F: FnOnce(&mut BackgroundTask),
    {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| String::from("Failed to acquire background task lock."))?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Background task with id {task_id} was not found."))?;
        updater(task);
        task.updated_at = now_iso();
        Ok(())
    }
}

#[derive(Default)]
pub struct ModelDownloadState {
    jobs: Mutex<HashMap<String, ManagedTranscriptionModel>>,
}

impl ModelDownloadState {
    pub fn snapshot(&self) -> Result<HashMap<String, ManagedTranscriptionModel>, String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        Ok(jobs.clone())
    }

    pub fn upsert(&self, model: ManagedTranscriptionModel) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        jobs.insert(model.id.clone(), model);
        Ok(())
    }

    pub fn start(&self, mut model: ManagedTranscriptionModel) -> Result<bool, String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        if jobs
            .get(&model.id)
            .is_some_and(|existing| existing.download_status == ModelDownloadStatus::Downloading)
        {
            return Ok(false);
        }

        model.download_status = ModelDownloadStatus::Downloading;
        model.downloaded_bytes = 0;
        model.total_bytes = Some(model.size_bytes);
        model.error = None;
        jobs.insert(model.id.clone(), model);
        Ok(true)
    }

    pub fn progress(
        &self,
        model_id: &str,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    ) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        if let Some(job) = jobs.get_mut(model_id) {
            job.download_status = ModelDownloadStatus::Downloading;
            job.downloaded_bytes = downloaded_bytes;
            job.total_bytes = total_bytes.or(job.total_bytes);
            job.error = None;
        }
        Ok(())
    }

    pub fn complete(
        &self,
        model_id: &str,
        installed_path: String,
        total_bytes: u64,
    ) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        if let Some(job) = jobs.get_mut(model_id) {
            job.installed = true;
            job.installed_path = Some(installed_path);
            job.download_status = ModelDownloadStatus::Completed;
            job.downloaded_bytes = total_bytes;
            job.total_bytes = Some(total_bytes);
            job.error = None;
            job.managed_by_app = true;
        }
        Ok(())
    }

    pub fn fail(&self, model_id: &str, error: String) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        if let Some(job) = jobs.get_mut(model_id) {
            job.download_status = ModelDownloadStatus::Error;
            job.error = Some(error);
        }
        Ok(())
    }

    pub fn clear(&self, model_id: &str) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| String::from("Failed to acquire model download lock."))?;
        jobs.remove(model_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::TranscriptionTaskState;
    use crate::models::{BackgroundTaskKind, BackgroundTaskStatus, TaskFailureLog};

    #[test]
    fn tracks_background_task_lifecycle() {
        let state = TranscriptionTaskState::default();
        let task = state
            .create_task(
                BackgroundTaskKind::FinalTranscription,
                String::from("Transcribe"),
                Some(String::from("session-1")),
                None,
                true,
            )
            .expect("task should be created");

        state
            .start_task(&task.id, "Running")
            .expect("task should start");
        state
            .progress_task(&task.id, "Halfway", 50.0, Some(1), Some(2), None, None)
            .expect("task should update");

        let task = state
            .list_tasks()
            .expect("tasks should list")
            .into_iter()
            .find(|candidate| candidate.id == task.id)
            .expect("task should be listed");
        assert_eq!(task.status, BackgroundTaskStatus::Running);
        assert_eq!(task.percent, 50.0);
        assert_eq!(task.completed_chunks, 1);
        assert_eq!(task.total_chunks, 2);

        state
            .succeed_task(&task.id, "Done")
            .expect("task should complete");
        let task = state
            .list_tasks()
            .expect("tasks should list")
            .into_iter()
            .find(|candidate| candidate.id == task.id)
            .expect("task should be listed");
        assert_eq!(task.status, BackgroundTaskStatus::Succeeded);
        assert_eq!(task.percent, 100.0);
        assert!(!task.cancelable);
    }

    #[test]
    fn marks_task_canceled() {
        let state = TranscriptionTaskState::default();
        let task = state
            .create_task(
                BackgroundTaskKind::ModelDownload,
                String::from("Download"),
                None,
                Some(String::from("ggml-base.bin")),
                true,
            )
            .expect("task should be created");

        let canceled = state
            .cancel_task(&task.id)
            .expect("task should cancel");

        assert_eq!(canceled.status, BackgroundTaskStatus::Canceled);
        assert!(state.is_canceled(&task.id).expect("cancel check should work"));
    }

    #[test]
    fn stores_and_clears_task_failure_log() {
        let state = TranscriptionTaskState::default();
        let task = state
            .create_task(
                BackgroundTaskKind::FinalTranscription,
                String::from("Transcribe"),
                Some(String::from("session-1")),
                None,
                true,
            )
            .expect("task should be created");
        let failure_log = TaskFailureLog {
            occurred_at: String::from("2026-05-13T00:00:00Z"),
            command_label: Some(String::from("ffmpeg")),
            command: Some(String::from("ffmpeg -i input.wav output.wav")),
            exit_code: Some(1),
            stderr_excerpt: Some(String::from("invalid data")),
            log_path: Some(String::from("/tmp/task/latest.json")),
            stderr_path: Some(String::from("/tmp/task/latest.stderr.log")),
        };

        let failed = state
            .fail_task(&task.id, String::from("ffmpeg failed"), Some(failure_log))
            .expect("task should fail");

        assert_eq!(failed.status, BackgroundTaskStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("ffmpeg failed"));
        assert_eq!(
            failed
                .failure_log
                .as_ref()
                .and_then(|log| log.command_label.as_deref()),
            Some("ffmpeg")
        );

        state
            .progress_task(&task.id, "Retrying", 10.0, None, None, None, None)
            .expect("task should update");
        let retried = state
            .list_tasks()
            .expect("tasks should list")
            .into_iter()
            .find(|candidate| candidate.id == task.id)
            .expect("task should be listed");
        assert_eq!(retried.status, BackgroundTaskStatus::Running);
        assert!(retried.failure_log.is_none());
        assert!(retried.error.is_none());
    }

    #[test]
    fn cancels_active_tasks_for_session() {
        let state = TranscriptionTaskState::default();
        let session_task = state
            .create_task(
                BackgroundTaskKind::FinalTranscription,
                String::from("Transcribe"),
                Some(String::from("session-1")),
                None,
                true,
            )
            .expect("task should be created");
        let other_task = state
            .create_task(
                BackgroundTaskKind::FinalTranscription,
                String::from("Other"),
                Some(String::from("session-2")),
                None,
                true,
            )
            .expect("other task should be created");

        state
            .start_task(&session_task.id, "Running")
            .expect("task should start");
        state
            .start_task(&other_task.id, "Running")
            .expect("other task should start");

        let canceled = state
            .cancel_session_tasks("session-1")
            .expect("session tasks should cancel");

        assert_eq!(canceled.len(), 1);
        assert_eq!(canceled[0].id, session_task.id);
        assert!(state
            .is_canceled(&session_task.id)
            .expect("cancel check should work"));
        assert!(!state
            .is_canceled(&other_task.id)
            .expect("cancel check should work"));
    }
}
