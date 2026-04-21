import { useEffect } from "react";
import { getSession, listSessions } from "../lib/tauri";
import type { LectureSession } from "../types/session";

interface UseSessionPollingOptions {
  sessionId?: string | null;
  enabled: boolean;
  intervalMs?: number;
  onSession?: (session: LectureSession) => void;
  onSessions?: (sessions: LectureSession[]) => void;
  onError?: (message: string) => void;
}

export function useSessionPolling({
  sessionId,
  enabled,
  intervalMs = 1_000,
  onSession,
  onSessions,
  onError,
}: UseSessionPollingOptions) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isActive = true;

    const run = async () => {
      try {
        if (sessionId) {
          const session = await getSession(sessionId);
          if (isActive) {
            onSession?.(session);
          }
          return;
        }

        const sessions = await listSessions();
        if (isActive) {
          onSessions?.(sessions);
        }
      } catch (error) {
        if (isActive && onError) {
          onError(error instanceof Error ? error.message : "Failed to refresh session state.");
        }
      }
    };

    void run();
    const intervalId = window.setInterval(() => {
      void run();
    }, intervalMs);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, onError, onSession, onSessions, sessionId]);
}
