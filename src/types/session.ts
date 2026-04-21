export type SessionStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "done";

export type CaptureSource = "microphone" | "systemAudio";

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

export interface LectureSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  captureSource: CaptureSource;
  status: SessionStatus;
  durationMs: number;
  segments: TranscriptSegment[];
  sessionDir: string | null;
  audioFilePaths: string[];
  activeAudioFilePath: string | null;
  audioMimeType: string | null;
  normalizedAudioPath: string | null;
  processedTranscriptPath: string | null;
  lastResumedAt: string | null;
  captureTargetLabel: string | null;
}

export interface RecentState {
  activeSessionId: string | null;
  draftTitle: string;
  draftCaptureSource: CaptureSource;
  lastViewedSessionId: string | null;
}
