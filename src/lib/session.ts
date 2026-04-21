import type { LectureSession } from "../types/session";

export function getLiveDurationMs(
  session: Pick<LectureSession, "durationMs" | "lastResumedAt" | "status">,
  now = Date.now(),
) {
  if (session.status !== "recording" || !session.lastResumedAt) {
    return session.durationMs;
  }

  const resumedAtMs = new Date(session.lastResumedAt).getTime();
  if (Number.isNaN(resumedAtMs)) {
    return session.durationMs;
  }

  return session.durationMs + Math.max(0, now - resumedAtMs);
}
