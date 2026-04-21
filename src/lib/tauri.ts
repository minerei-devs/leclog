import { invoke } from "@tauri-apps/api/core";
import type {
  CaptureSource,
  LectureSession,
  ManagedTranscriptionModel,
  TranscriptionModelInfo,
  TranscriptionSettings,
  TranscriptSegment,
} from "../types/session";

export function createSession(title?: string, captureSource?: CaptureSource) {
  return invoke<LectureSession>("create_session", {
    title: title?.trim() ? title.trim() : null,
    captureSource: captureSource ?? "microphone",
  });
}

export function importMediaSession(
  filePath: string,
  title?: string,
  settings?: Partial<TranscriptionSettings>,
) {
  return invoke<LectureSession>("import_media_session", {
    filePath,
    title: title?.trim() ? title.trim() : null,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage: settings?.preferredLanguage?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
  });
}

export function listSessions() {
  return invoke<LectureSession[]>("list_sessions");
}

export function getSession(id: string) {
  return invoke<LectureSession>("get_session", { id });
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
  settings?: Partial<TranscriptionSettings>,
) {
  return invoke<LectureSession>("queue_live_transcript_refresh", {
    sessionId,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage: settings?.preferredLanguage?.trim() || null,
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

export function saveSession(sessionId: string, settings?: Partial<TranscriptionSettings>) {
  return invoke<void>("save_session", {
    sessionId,
    preferredModelId: settings?.preferredModelId ?? null,
    preferredLanguage: settings?.preferredLanguage?.trim() || null,
    promptTerms: settings?.promptTerms?.trim() || null,
  });
}

export function polishSessionTranscript(sessionId: string) {
  return invoke<LectureSession>("polish_session_transcript", {
    sessionId,
  });
}
