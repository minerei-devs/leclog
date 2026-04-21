export type SessionStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "done";

export type CaptureSource = "microphone" | "systemAudio" | "importedMedia";
export type TranscriptPhase = "idle" | "live" | "processing" | "ready" | "error";
export type ModelDownloadStatus = "idle" | "downloading" | "completed" | "error";

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
  polishedTranscriptPath: string | null;
  polishedTranscriptText: string | null;
  livePreviewAudioPath: string | null;
  livePreviewSampleRate: number | null;
  transcriptPhase: TranscriptPhase;
  transcriptError: string | null;
  audioLevel: number | null;
  lastResumedAt: string | null;
  captureTargetLabel: string | null;
}

export interface RecentState {
  activeSessionId: string | null;
  draftTitle: string;
  draftCaptureSource: CaptureSource;
  lastViewedSessionId: string | null;
}

export interface TranscriptionModelInfo {
  id: string;
  label: string;
  path: string;
  sizeBytes: number;
  recommended: boolean;
}

export interface ManagedTranscriptionModel {
  id: string;
  label: string;
  sourceUrl: string;
  sizeBytes: number;
  recommended: boolean;
  installed: boolean;
  installedPath: string | null;
  downloadStatus: ModelDownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  managedByApp: boolean;
}

export interface TranscriptionSettings {
  preferredModelId: string | null;
  preferredLanguage: string;
  promptTerms: string;
}
