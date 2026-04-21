import { useEffect, useRef } from "react";
import { getLiveDurationMs } from "../lib/session";
import { appendSegment } from "../lib/tauri";
import { buildMockSegment } from "../lib/mockSegments";
import type { LectureSession } from "../types/session";

interface UseMockTranscriptStreamOptions {
  session: LectureSession | null;
  onSessionUpdate: (session: LectureSession) => void;
  onError: (message: string) => void;
}

export function useMockTranscriptStream({
  session,
  onSessionUpdate,
  onError,
}: UseMockTranscriptStreamOptions) {
  const segmentIndexRef = useRef(0);
  const isAppendingRef = useRef(false);
  const sessionRef = useRef<LectureSession | null>(session);

  useEffect(() => {
    sessionRef.current = session;

    if (session) {
      segmentIndexRef.current = session.segments.length;
    }
  }, [session]);

  useEffect(() => {
    if (!session || session.status !== "recording") {
      return;
    }

    const intervalId = window.setInterval(async () => {
      if (isAppendingRef.current || !sessionRef.current) {
        return;
      }

      try {
        isAppendingRef.current = true;
        const currentSession = sessionRef.current;
        const lastEndMs =
          currentSession.segments[currentSession.segments.length - 1]?.endMs ?? 0;
        const liveDurationMs = getLiveDurationMs(currentSession);
        const nextStartMs = lastEndMs;
        const nextEndMs = Math.max(nextStartMs + 1, liveDurationMs);
        const nextSegment = buildMockSegment(
          segmentIndexRef.current,
          nextStartMs,
          nextEndMs,
        );

        const updated = await appendSegment(currentSession.id, nextSegment);
        segmentIndexRef.current += 1;
        onSessionUpdate(updated);
      } catch (error) {
        onError(
          error instanceof Error
            ? error.message
            : "Failed to append a mock transcript segment.",
        );
      } finally {
        isAppendingRef.current = false;
      }
    }, 2_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [onError, onSessionUpdate, session]);
}
