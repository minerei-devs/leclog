use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub status: SessionStatus,
    pub duration_ms: u64,
    pub segments: Vec<TranscriptSegment>,
}
