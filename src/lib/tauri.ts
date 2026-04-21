import { invoke } from "@tauri-apps/api/core";
import type { LectureSession, TranscriptSegment } from "../types/session";

export function createSession(title?: string) {
  return invoke<LectureSession>("create_session", {
    title: title?.trim() ? title.trim() : null,
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
