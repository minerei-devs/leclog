import { invoke } from "@tauri-apps/api/core";
import type { CaptureSource, LectureSession, TranscriptSegment } from "../types/session";

export function createSession(title?: string, captureSource?: CaptureSource) {
  return invoke<LectureSession>("create_session", {
    title: title?.trim() ? title.trim() : null,
    captureSource: captureSource ?? "microphone",
  });
}

export function listSessions() {
  return invoke<LectureSession[]>("list_sessions");
}

export function getSession(id: string) {
  return invoke<LectureSession>("get_session", { id });
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

export function saveSession(sessionId: string) {
  return invoke<void>("save_session", {
    sessionId,
  });
}
