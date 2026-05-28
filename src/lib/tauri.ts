import { invoke } from "@tauri-apps/api/core";
import type {
  CaptureSource,
  BackgroundTask,
  LectureSession,
  ManagedTranscriptionModel,
  PlatformCapabilities,
  ProcessingSettings,
  ResourceOverview,
  RuntimeStatus,
  SessionExportRequest,
  SessionExportResult,
  SessionSummary,
  TranscriptionModelInfo,
  TranscriptionSettings,
  TranscriptSegment,
} from "../types/session";

export function createSession(
  title?: string,
  captureSource?: CaptureSource,
  settings?: Partial<TranscriptionSettings & ProcessingSettings>,
) {
  return invoke<LectureSession>("create_session", {
    title: title?.trim() ? title.trim() : null,
    captureSource: captureSource ?? "microphone",
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage:
      settings?.preferredLanguage?.trim() || settings?.language?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  });
}

export function importMediaSession(
  filePath: string,
  title?: string,
  settings?: Partial<TranscriptionSettings & ProcessingSettings>,
) {
  return invoke<LectureSession>("import_media_session", {
    filePath,
    title: title?.trim() ? title.trim() : null,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage:
      settings?.preferredLanguage?.trim() || settings?.language?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  });
}

export function listSessions() {
  return invoke<LectureSession[]>("list_sessions");
}

export function listSessionSummaries() {
  return invoke<SessionSummary[]>("list_session_summaries");
}

export function getSession(id: string) {
  return invoke<LectureSession>("get_session", { id });
}

export function exportSessionDeliverable(request: SessionExportRequest) {
  return invoke<SessionExportResult>("export_session_deliverable", { request });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return invoke<LectureSession>("update_session_title", {
    sessionId,
    title: title.trim(),
  });
}

export function getPlatformCapabilities() {
  return invoke<PlatformCapabilities>("get_platform_capabilities");
}

export function listTranscriptionModels() {
  return invoke<TranscriptionModelInfo[]>("list_transcription_models");
}

export function listAvailableTranscriptionModels() {
  return invoke<ManagedTranscriptionModel[]>("list_available_transcription_models");
}

export function downloadTranscriptionModel(modelId: string) {
  return invoke<void>("download_transcription_model", {
    modelId,
  });
}

export function prepareTranscriptionRuntime() {
  return invoke<void>("prepare_transcription_runtime");
}

export function deleteTranscriptionModel(modelId: string) {
  return invoke<void>("delete_transcription_model", {
    modelId,
  });
}

export function appendSegment(sessionId: string, segment: TranscriptSegment) {
  return invoke<LectureSession>("append_segment", {
    sessionId,
    segment,
  });
}

export function beginAudioSegment(
  sessionId: string,
  mimeType: string,
  extension: string,
) {
  return invoke<LectureSession>("begin_audio_segment", {
    sessionId,
    mimeType,
    extension,
  });
}

export function appendAudioChunk(sessionId: string, chunk: number[]) {
  return invoke<void>("append_audio_chunk", {
    sessionId,
    chunk,
  });
}

export function finishAudioSegment(sessionId: string) {
  return invoke<LectureSession>("finish_audio_segment", {
    sessionId,
  });
}

export function initializeLivePreview(
  sessionId: string,
  sampleRate: number,
  reset = false,
) {
  return invoke<LectureSession>("initialize_live_preview", {
    sessionId,
    sampleRate,
    reset,
  });
}

export function appendLivePreviewChunk(sessionId: string, chunk: number[]) {
  return invoke<void>("append_live_preview_chunk", {
    sessionId,
    chunk,
  });
}

export function queueLiveTranscriptRefresh(
  sessionId: string,
  settings?: Partial<TranscriptionSettings & ProcessingSettings>,
) {
  return invoke<LectureSession>("queue_live_transcript_refresh", {
    sessionId,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage:
      settings?.preferredLanguage?.trim() || settings?.language?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
  });
}

export function startSessionRecording(sessionId: string) {
  return invoke<LectureSession>("start_session_recording", {
    sessionId,
  });
}

export function pauseSessionRecording(sessionId: string) {
  return invoke<LectureSession>("pause_session_recording", {
    sessionId,
  });
}

export function resumeSessionRecording(sessionId: string) {
  return invoke<LectureSession>("resume_session_recording", {
    sessionId,
  });
}

export function stopSessionRecording(sessionId: string) {
  return invoke<LectureSession>("stop_session_recording", {
    sessionId,
  });
}

export function setSessionStatus(sessionId: string, status: string) {
  return invoke<LectureSession>("set_session_status", {
    sessionId,
    status,
  });
}

export function saveSession(
  sessionId: string,
  settings?: Partial<TranscriptionSettings & ProcessingSettings>,
) {
  return invoke<void>("save_session", {
    sessionId,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage:
      settings?.preferredLanguage?.trim() || settings?.language?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  });
}

export function polishSessionTranscript(sessionId: string) {
  return invoke<LectureSession>("polish_session_transcript", {
    sessionId,
  });
}

export function saveSessionWithProcessingSettings(
  sessionId: string,
  settings?: Partial<TranscriptionSettings & ProcessingSettings>,
) {
  return invoke<void>("save_session", {
    sessionId,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage:
      settings?.preferredLanguage?.trim() || settings?.language?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  });
}

export function getRuntimeStatus() {
  return invoke<RuntimeStatus>("get_runtime_status");
}

export function listResources() {
  return invoke<ResourceOverview>("list_resources");
}

export function deleteSession(sessionId: string) {
  return invoke<void>("delete_session", { sessionId });
}

export function cleanupSessionIntermediates(sessionId: string) {
  return invoke<LectureSession>("cleanup_session_intermediates", { sessionId });
}

export function deleteResource(
  path: string,
  sessionId?: string | null,
  modelId?: string | null,
) {
  return invoke<ResourceOverview>("delete_resource", {
    path,
    sessionId: sessionId ?? null,
    modelId: modelId ?? null,
  });
}

export function revealResource(path: string) {
  return invoke<void>("reveal_resource", { path });
}

export function listBackgroundTasks() {
  return invoke<BackgroundTask[]>("list_background_tasks");
}

export function cancelBackgroundTask(taskId: string) {
  return invoke<BackgroundTask>("cancel_background_task", { taskId });
}

export function retrySessionProcessing(sessionId: string) {
  return invoke<LectureSession>("retry_session_processing", { sessionId });
}

export function getProcessingSettings() {
  return invoke<ProcessingSettings>("get_processing_settings");
}

export function patchProcessingSettings(patch: Partial<ProcessingSettings>) {
  return invoke<ProcessingSettings>("patch_processing_settings", {
    qualityPreset: patch.qualityPreset ?? null,
    preferredModelId: patch.preferredModelId ?? null,
    clearPreferredModelId: patch.preferredModelId === null,
    language: patch.language ?? null,
    promptTerms: patch.promptTerms ?? null,
    chunkDurationMinutes: patch.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: patch.chunkOverlapSeconds ?? null,
    whisperThreads: patch.whisperThreads ?? null,
    clearWhisperThreads: patch.whisperThreads === null,
    maxParallelChunks: patch.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: patch.liveRefreshIntervalSeconds ?? null,
  });
}
