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

interface CachedInvokeEntry<T> {
  value?: T;
  valueAt: number;
  promise?: Promise<T>;
}

const cachedInvokes = new Map<string, CachedInvokeEntry<unknown>>();
const RUNTIME_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_CACHE_TTL_MS = 30 * 1000;

function invokeCached<T>(
  cacheKey: string,
  command: string,
  args?: Record<string, unknown>,
  ttlMs = 750,
  force = false,
) {
  const now = Date.now();
  if (force) {
    cachedInvokes.delete(cacheKey);
  }
  const cached = cachedInvokes.get(cacheKey) as CachedInvokeEntry<T> | undefined;

  if (cached?.promise) {
    return cached.promise;
  }

  if (cached?.value !== undefined && now - cached.valueAt < ttlMs) {
    return Promise.resolve(cached.value);
  }

  const entry: CachedInvokeEntry<T> = cached ?? {
    valueAt: 0,
  };
  const promise = invoke<T>(command, args)
    .then((value) => {
      entry.value = value;
      entry.valueAt = Date.now();
      entry.promise = undefined;
      return value;
    })
    .catch((error) => {
      entry.promise = undefined;
      throw error;
    });

  entry.promise = promise;
  cachedInvokes.set(cacheKey, entry as CachedInvokeEntry<unknown>);
  return promise;
}

function clearCachedInvokes(...prefixes: string[]) {
  for (const key of cachedInvokes.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      cachedInvokes.delete(key);
    }
  }
}

function notifySessionsChanged() {
  window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
}

function clearSessionCachesAndNotify(...prefixes: string[]) {
  clearCachedInvokes(...prefixes);
  notifySessionsChanged();
}

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
    whisperRuntimePreference: settings?.whisperRuntimePreference ?? null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", "session:");
    return session;
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
    whisperRuntimePreference: settings?.whisperRuntimePreference ?? null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", "session:");
    return session;
  });
}

export function listSessions() {
  return invokeCached<LectureSession[]>("sessions:full", "list_sessions");
}

export function listSessionSummaries() {
  return invokeCached<SessionSummary[]>("sessions:summaries", "list_session_summaries");
}

export function getSession(id: string) {
  return invokeCached<LectureSession>(`session:${id}`, "get_session", { id });
}

export function exportSessionDeliverable(request: SessionExportRequest) {
  return invoke<SessionExportResult>("export_session_deliverable", { request });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return invoke<LectureSession>("update_session_title", {
    sessionId,
    title: title.trim(),
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
  });
}

export function getPlatformCapabilities() {
  return invokeCached<PlatformCapabilities>(
    "platform-capabilities",
    "get_platform_capabilities",
    undefined,
    60_000,
  );
}

export function listTranscriptionModels() {
  return invokeCached<TranscriptionModelInfo[]>(
    "transcription-models:installed",
    "list_transcription_models",
  );
}

export function listAvailableTranscriptionModels() {
  return invokeCached<ManagedTranscriptionModel[]>(
    "transcription-models:available",
    "list_available_transcription_models",
    undefined,
    MODEL_LIST_CACHE_TTL_MS,
  );
}

export function downloadTranscriptionModel(modelId: string) {
  return invoke<void>("download_transcription_model", {
    modelId,
  }).then((result) => {
    clearCachedInvokes("transcription-models", "runtime-status", "background-tasks");
    return result;
  });
}

export function prepareTranscriptionRuntime() {
  return invoke<void>("prepare_transcription_runtime").then((result) => {
    clearCachedInvokes("transcription-models", "runtime-status", "background-tasks");
    return result;
  });
}

export function deleteTranscriptionModel(modelId: string) {
  return invoke<void>("delete_transcription_model", {
    modelId,
  }).then((result) => {
    clearCachedInvokes("transcription-models", "runtime-status");
    return result;
  });
}

export function appendSegment(sessionId: string, segment: TranscriptSegment) {
  return invoke<LectureSession>("append_segment", {
    sessionId,
    segment,
  }).then((session) => {
    clearCachedInvokes("sessions", `session:${sessionId}`);
    return session;
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
  }).then((session) => {
    clearCachedInvokes("sessions", `session:${sessionId}`);
    return session;
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
  }).then((session) => {
    clearCachedInvokes("sessions", `session:${sessionId}`);
    return session;
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
  }).then((session) => {
    clearCachedInvokes("sessions", `session:${sessionId}`);
    return session;
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
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "background-tasks");
    return session;
  });
}

export function startSessionRecording(sessionId: string) {
  return invoke<LectureSession>("start_session_recording", {
    sessionId,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
  });
}

export function pauseSessionRecording(sessionId: string) {
  return invoke<LectureSession>("pause_session_recording", {
    sessionId,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
  });
}

export function resumeSessionRecording(sessionId: string) {
  return invoke<LectureSession>("resume_session_recording", {
    sessionId,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
  });
}

export function stopSessionRecording(sessionId: string) {
  return invoke<LectureSession>("stop_session_recording", {
    sessionId,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "background-tasks");
    return session;
  });
}

export function setSessionStatus(sessionId: string, status: string) {
  return invoke<LectureSession>("set_session_status", {
    sessionId,
    status,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
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
    whisperRuntimePreference: settings?.whisperRuntimePreference ?? null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  }).then((result) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "background-tasks");
    return result;
  });
}

export function polishSessionTranscript(sessionId: string) {
  return invoke<LectureSession>("polish_session_transcript", {
    sessionId,
  }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`);
    return session;
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
    whisperRuntimePreference: settings?.whisperRuntimePreference ?? null,
    qualityPreset: settings?.qualityPreset ?? null,
    chunkDurationMinutes: settings?.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: settings?.chunkOverlapSeconds ?? null,
    whisperThreads: settings?.whisperThreads ?? null,
    maxParallelChunks: settings?.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: settings?.liveRefreshIntervalSeconds ?? null,
  }).then((result) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "background-tasks");
    return result;
  });
}

export function getRuntimeStatus(options?: { force?: boolean }) {
  return invokeCached<RuntimeStatus>(
    "runtime-status",
    "get_runtime_status",
    undefined,
    RUNTIME_STATUS_CACHE_TTL_MS,
    options?.force ?? false,
  );
}

export function listResources() {
  return invokeCached<ResourceOverview>("resources", "list_resources", undefined, 1_000);
}

export function deleteSession(sessionId: string) {
  return invoke<void>("delete_session", { sessionId }).then((result) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "resources", "background-tasks");
    return result;
  });
}

export function cleanupSessionIntermediates(sessionId: string) {
  return invoke<LectureSession>("cleanup_session_intermediates", { sessionId }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "resources");
    return session;
  });
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
  }).then((overview) => {
    clearSessionCachesAndNotify(
      "sessions",
      "session:",
      "resources",
      "transcription-models",
      "runtime-status",
    );
    return overview;
  });
}

export function revealResource(path: string) {
  return invoke<void>("reveal_resource", { path });
}

export function listBackgroundTasks() {
  return invokeCached<BackgroundTask[]>("background-tasks", "list_background_tasks", undefined, 500);
}

export function cancelBackgroundTask(taskId: string) {
  return invoke<BackgroundTask>("cancel_background_task", { taskId }).then((task) => {
    clearSessionCachesAndNotify("sessions", "background-tasks");
    return task;
  });
}

export function retrySessionProcessing(sessionId: string) {
  return invoke<LectureSession>("retry_session_processing", { sessionId }).then((session) => {
    clearSessionCachesAndNotify("sessions", `session:${sessionId}`, "background-tasks");
    return session;
  });
}

export function getProcessingSettings() {
  return invokeCached<ProcessingSettings>(
    "processing-settings",
    "get_processing_settings",
    undefined,
    5_000,
  );
}

export function patchProcessingSettings(patch: Partial<ProcessingSettings>) {
  return invoke<ProcessingSettings>("patch_processing_settings", {
    qualityPreset: patch.qualityPreset ?? null,
    preferredModelId: patch.preferredModelId ?? null,
    clearPreferredModelId: patch.preferredModelId === null,
    language: patch.language ?? null,
    promptTerms: patch.promptTerms ?? null,
    whisperRuntimePreference: patch.whisperRuntimePreference ?? null,
    chunkDurationMinutes: patch.chunkDurationMinutes ?? null,
    chunkOverlapSeconds: patch.chunkOverlapSeconds ?? null,
    whisperThreads: patch.whisperThreads ?? null,
    clearWhisperThreads: patch.whisperThreads === null,
    maxParallelChunks: patch.maxParallelChunks ?? null,
    liveRefreshIntervalSeconds: patch.liveRefreshIntervalSeconds ?? null,
  }).then((settings) => {
    clearCachedInvokes("processing-settings", "runtime-status");
    return settings;
  });
}
