import { useEffect, useRef } from "react";
import { refreshLiveTranscript } from "../lib/tauri";
import type { LectureSession } from "../types/session";

interface UseLiveTranscriptOptions {
  session: LectureSession | null;
  onSessionUpdate: (session: LectureSession) => void;
  onError: (message: string) => void;
}

export function useLiveTranscript({
  session,
  onSessionUpdate,
  onError,
}: UseLiveTranscriptOptions) {
  const isRefreshingRef = useRef(false);
  const sessionRef = useRef<LectureSession | null>(session);

  useEffect(() => {
    if (!session || session.status !== "paused" || isRefreshingRef.current) {
      return;
    }

    void (async () => {
      try {
        isRefreshingRef.current = true;
        const updated = await refreshLiveTranscript(session.id);
        onSessionUpdate(updated);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Failed to refresh the paused transcript.",
        );
      } finally {
        isRefreshingRef.current = false;
      }
    })();
  }, [onError, onSessionUpdate, session]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!session || session.status !== "recording") {
      return;
    }

    const intervalId = window.setInterval(async () => {
      if (isRefreshingRef.current || !sessionRef.current) {
        return;
      }

      try {
        isRefreshingRef.current = true;
        const updated = await refreshLiveTranscript(sessionRef.current.id);
        onSessionUpdate(updated);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Failed to refresh the live transcript.",
        );
      } finally {
        isRefreshingRef.current = false;
      }
    }, 8_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [onError, onSessionUpdate, session]);
}
