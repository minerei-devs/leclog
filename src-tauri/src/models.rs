use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSource {
    Microphone,
    SystemAudio,
    ImportedMedia,
}

impl CaptureSource {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("microphone") {
            "microphone" => Ok(Self::Microphone),
            "systemAudio" => Ok(Self::SystemAudio),
            "importedMedia" => Ok(Self::ImportedMedia),
            other => Err(format!("Unsupported capture source: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Recording,
    Paused,
    Processing,
    Done,
}

impl SessionStatus {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "idle" => Ok(Self::Idle),
            "recording" => Ok(Self::Recording),
            "paused" => Ok(Self::Paused),
            "processing" => Ok(Self::Processing),
            "done" => Ok(Self::Done),
            _ => Err(format!("Unsupported session status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptPhase {
    Idle,
    Live,
    Processing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub is_final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LectureSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_capture_source")]
    pub capture_source: CaptureSource,
    pub status: SessionStatus,
    pub duration_ms: u64,
    pub segments: Vec<TranscriptSegment>,
    #[serde(default)]
    pub session_dir: Option<String>,
    #[serde(default)]
    pub audio_file_paths: Vec<String>,
    #[serde(default)]
    pub active_audio_file_path: Option<String>,
    #[serde(default)]
    pub audio_mime_type: Option<String>,
    #[serde(default)]
    pub normalized_audio_path: Option<String>,
    #[serde(default)]
    pub processed_transcript_path: Option<String>,
    #[serde(default)]
    pub polished_transcript_path: Option<String>,
    #[serde(default)]
    pub polished_transcript_text: Option<String>,
    #[serde(default)]
    pub live_preview_audio_path: Option<String>,
    #[serde(default)]
    pub live_preview_sample_rate: Option<u32>,
    #[serde(default = "default_transcript_phase")]
    pub transcript_phase: TranscriptPhase,
    #[serde(default)]
    pub transcript_error: Option<String>,
    #[serde(default)]
    pub audio_level: Option<f32>,
    #[serde(default)]
    pub last_resumed_at: Option<String>,
    #[serde(default)]
    pub capture_target_label: Option<String>,
    #[serde(default)]
    pub processing_settings: Option<ProcessingSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub capture_source: CaptureSource,
    pub status: SessionStatus,
    pub duration_ms: u64,
    pub transcript_phase: TranscriptPhase,
    pub transcript_error: Option<String>,
    pub audio_level: Option<f32>,
    pub capture_target_label: Option<String>,
    pub segment_count: usize,
}

impl LectureSession {
    pub fn mark_processing_interrupted(&mut self, transcript_error: impl Into<String>) -> bool {
        if self.status != SessionStatus::Processing
            && self.transcript_phase != TranscriptPhase::Processing
        {
            return false;
        }

        if self.status == SessionStatus::Processing {
            self.status = SessionStatus::Done;
        }
        self.transcript_phase = TranscriptPhase::Error;
        self.transcript_error = Some(transcript_error.into());
        true
    }
}

fn default_capture_source() -> CaptureSource {
    CaptureSource::Microphone
}

fn default_transcript_phase() -> TranscriptPhase {
    TranscriptPhase::Idle
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelDownloadStatus {
    Idle,
    Downloading,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTranscriptionModel {
    pub id: String,
    pub label: String,
    pub source_url: String,
    pub size_bytes: u64,
    pub recommended: bool,
    pub installed: bool,
    pub installed_path: Option<String>,
    pub download_status: ModelDownloadStatus,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub managed_by_app: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessingQualityPreset {
    Fast,
    Balanced,
    Accurate,
    Custom,
}

impl ProcessingQualityPreset {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "fast" => Ok(Self::Fast),
            "balanced" => Ok(Self::Balanced),
            "accurate" => Ok(Self::Accurate),
            "custom" => Ok(Self::Custom),
            other => Err(format!("Unsupported processing quality preset: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingSettings {
    pub quality_preset: ProcessingQualityPreset,
    pub preferred_model_id: Option<String>,
    pub language: String,
    pub prompt_terms: String,
    pub chunk_duration_minutes: u32,
    pub chunk_overlap_seconds: u32,
    pub whisper_threads: Option<u32>,
    pub max_parallel_chunks: u32,
    pub live_refresh_interval_seconds: u32,
}

impl Default for ProcessingSettings {
    fn default() -> Self {
        Self {
            quality_preset: ProcessingQualityPreset::Balanced,
            preferred_model_id: None,
            language: String::from("auto"),
            prompt_terms: String::new(),
            chunk_duration_minutes: 10,
            chunk_overlap_seconds: 20,
            whisper_threads: None,
            max_parallel_chunks: 1,
            live_refresh_interval_seconds: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundTaskStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskKind {
    FinalTranscription,
    LiveTranscription,
    ModelDownload,
    ImportMedia,
    Cleanup,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFailureLog {
    pub occurred_at: String,
    pub command_label: Option<String>,
    pub command: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr_excerpt: Option<String>,
    pub log_path: Option<String>,
    pub stderr_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: BackgroundTaskKind,
    pub status: BackgroundTaskStatus,
    pub title: String,
    pub step: String,
    pub percent: f32,
    pub completed_chunks: u32,
    pub total_chunks: u32,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub failure_log: Option<TaskFailureLog>,
    pub session_id: Option<String>,
    pub model_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub cancelable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    AppData,
    SessionDir,
    Audio,
    NormalizedAudio,
    LivePreviewAudio,
    Transcript,
    Model,
    PartialDownload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceItem {
    pub id: String,
    pub kind: ResourceKind,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub exists: bool,
    pub revealable: bool,
    pub deletable: bool,
    pub session_id: Option<String>,
    pub model_id: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOverview {
    pub app_data_dir: String,
    pub total_bytes: u64,
    pub session_bytes: u64,
    pub model_bytes: u64,
    pub processed_bytes: u64,
    pub temp_bytes: u64,
    pub resources: Vec<ResourceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub app_data_dir: String,
    pub is_app_data_writable: bool,
    pub ffmpeg_path: Option<String>,
    pub ffmpeg_available: bool,
    pub whisper_cli_path: Option<String>,
    pub whisper_available: bool,
    pub whisper_acceleration_available: bool,
    pub whisper_acceleration_label: Option<String>,
    pub installed_model_count: usize,
    pub installed_model_labels: Vec<String>,
    pub processing_session_count: usize,
    pub partial_download_count: usize,
    pub issues: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{CaptureSource, LectureSession, SessionStatus, TranscriptPhase};

    fn session(status: SessionStatus, transcript_phase: TranscriptPhase) -> LectureSession {
        LectureSession {
            id: String::from("session-1"),
            title: String::from("Session"),
            created_at: String::from("2026-05-13T00:00:00Z"),
            updated_at: String::from("2026-05-13T00:00:00Z"),
            capture_source: CaptureSource::Microphone,
            status,
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
            transcript_phase,
            transcript_error: None,
            audio_level: None,
            last_resumed_at: None,
            capture_target_label: None,
            processing_settings: None,
        }
    }

    #[test]
    fn interrupted_processing_session_becomes_terminal_error() {
        let mut session = session(SessionStatus::Processing, TranscriptPhase::Processing);

        let changed = session.mark_processing_interrupted("canceled");

        assert!(changed);
        assert_eq!(session.status, SessionStatus::Done);
        assert_eq!(session.transcript_phase, TranscriptPhase::Error);
        assert_eq!(session.transcript_error.as_deref(), Some("canceled"));
    }

    #[test]
    fn non_processing_session_is_not_changed_by_interruption_marker() {
        let mut session = session(SessionStatus::Done, TranscriptPhase::Ready);

        let changed = session.mark_processing_interrupted("canceled");

        assert!(!changed);
        assert_eq!(session.status, SessionStatus::Done);
        assert_eq!(session.transcript_phase, TranscriptPhase::Ready);
        assert!(session.transcript_error.is_none());
    }
}
