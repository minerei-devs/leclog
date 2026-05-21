import { useEffect, useRef } from "react";
import { queueLiveTranscriptRefresh } from "../lib/tauri";
import type { LectureSession, ProcessingSettings, TranscriptionSettings } from "../types/session";

interface UseLiveTranscriptOptions {
  session: LectureSession | null;
  settings: Partial<TranscriptionSettings & ProcessingSettings>;
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
  const liveRefreshIntervalSeconds = Math.max(
    10,
    Math.min(60, Number(settings.liveRefreshIntervalSeconds ?? 20)),
  );

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
    }, liveRefreshIntervalSeconds * 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [liveRefreshIntervalSeconds, onError, onSessionUpdate, session?.id, session?.status]);
}
