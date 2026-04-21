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
