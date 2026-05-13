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

export interface AppSettings {
  autoCheckUpdates: boolean;
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

export type ProcessingQualityPreset = "fast" | "balanced" | "accurate" | "custom";

export interface ProcessingSettings {
  qualityPreset: ProcessingQualityPreset;
  preferredModelId: string | null;
  language: string;
  promptTerms: string;
  chunkDurationMinutes: number;
  chunkOverlapSeconds: number;
  whisperThreads: number | null;
  maxParallelChunks: number;
  liveRefreshIntervalSeconds: number;
}

export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type BackgroundTaskKind =
  | "finalTranscription"
  | "liveTranscription"
  | "modelDownload"
  | "importMedia"
  | "cleanup";

export interface TaskFailureLog {
  occurredAt: string;
  commandLabel: string | null;
  command: string | null;
  exitCode: number | null;
  stderrExcerpt: string | null;
  logPath: string | null;
  stderrPath: string | null;
}

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  title: string;
  step: string;
  percent: number;
  completedChunks: number;
  totalChunks: number;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  failureLog: TaskFailureLog | null;
  sessionId: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  cancelable: boolean;
}

export type ResourceKind =
  | "appData"
  | "sessionDir"
  | "audio"
  | "normalizedAudio"
  | "livePreviewAudio"
  | "transcript"
  | "model"
  | "partialDownload";

export interface ResourceItem {
  id: string;
  kind: ResourceKind;
  label: string;
  path: string;
  sizeBytes: number;
  exists: boolean;
  revealable: boolean;
  deletable: boolean;
  sessionId: string | null;
  modelId: string | null;
  updatedAt: string | null;
}

export interface ResourceOverview {
  appDataDir: string;
  totalBytes: number;
  sessionBytes: number;
  modelBytes: number;
  processedBytes: number;
  tempBytes: number;
  resources: ResourceItem[];
}

export interface RuntimeStatus {
  appDataDir: string;
  isAppDataWritable: boolean;
  ffmpegPath: string | null;
  ffmpegAvailable: boolean;
  whisperCliPath: string | null;
  whisperAvailable: boolean;
  whisperAccelerationAvailable: boolean;
  whisperAccelerationLabel: string | null;
  installedModelCount: number;
  installedModelLabels: string[];
  processingSessionCount: number;
  partialDownloadCount: number;
  issues: string[];
}
