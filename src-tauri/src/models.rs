use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSource {
    Microphone,
    SystemAudio,
}

impl CaptureSource {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("microphone") {
            "microphone" => Ok(Self::Microphone),
            "systemAudio" => Ok(Self::SystemAudio),
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
    pub live_preview_audio_path: Option<String>,
    #[serde(default)]
    pub live_preview_sample_rate: Option<u32>,
    #[serde(default)]
    pub last_resumed_at: Option<String>,
    #[serde(default)]
    pub capture_target_label: Option<String>,
}

fn default_capture_source() -> CaptureSource {
    CaptureSource::Microphone
}
