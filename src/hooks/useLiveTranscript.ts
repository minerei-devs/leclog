import { useEffect, useRef } from "react";
import { queueLiveTranscriptRefresh } from "../lib/tauri";
import type { LectureSession, TranscriptionSettings } from "../types/session";

interface UseLiveTranscriptOptions {
  session: LectureSession | null;
  settings: Partial<TranscriptionSettings>;
  onSessionUpdate: (session: LectureSession) => void;
  onError: (message: string) => void;
}

export function useLiveTranscript({
  session,
  settings,
  onSessionUpdate,
  onError,
}: UseLiveTranscriptOptions) {
  const isRefreshingRef = useRef(false);
  const sessionRef = useRef<LectureSession | null>(session);
  const settingsRef = useRef(settings);

  useEffect(() => {
    if (!session || session.status !== "paused" || isRefreshingRef.current) {
      return;
    }

    void (async () => {
      try {
        isRefreshingRef.current = true;
        const updated = await queueLiveTranscriptRefresh(session.id, settingsRef.current);
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
  }, [onError, onSessionUpdate, session, settings]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
        const updated = await queueLiveTranscriptRefresh(
          sessionRef.current.id,
          settingsRef.current,
        );
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
    }, 4_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [onError, onSessionUpdate, session?.id, session?.status]);
}
