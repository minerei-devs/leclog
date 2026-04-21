import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMockTranscriptStream } from "../hooks/useMockTranscriptStream";
import { useRecentState } from "../hooks/useRecentState";
import { formatDuration } from "../lib/format";
import { getSession, saveSession, setSessionStatus } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { ControlBar } from "./ControlBar";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

export function RecordingPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSessionUpdate = useCallback((nextSession: LectureSession) => {
    setSession(nextSession);
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
  }, []);

  useMockTranscriptStream({
    session,
    onSessionUpdate: handleSessionUpdate,
    onError: handleError,
  });

  useEffect(() => {
    if (!sessionId) {
      setError("Missing session id.");
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    void getSession(sessionId)
      .then((result) => {
        if (!isMounted) {
          return;
        }

        setSession(result);
      })
      .catch((reason) => {
        if (!isMounted) {
          return;
        }

        setError(
          reason instanceof Error ? reason.message : "Failed to load session.",
        );
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!session?.id) {
      return;
    }

    void updateRecentState({
      activeSessionId: session.status === "done" ? null : session.id,
      lastViewedSessionId: session.id,
    });
  }, [session?.id, session?.status, updateRecentState]);

  async function updateStatus(nextStatus: "recording" | "paused") {
    if (!session) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      const updated = await setSessionStatus(session.id, nextStatus);
      setSession(updated);
      await updateRecentState({
        activeSessionId: updated.id,
        lastViewedSessionId: updated.id,
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to update session state.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStop() {
    if (!session) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      const processing = await setSessionStatus(session.id, "processing");
      setSession(processing);
      await saveSession(session.id);
      const completed = await setSessionStatus(session.id, "done");
      setSession(completed);
      await updateRecentState({
        activeSessionId: null,
        lastViewedSessionId: completed.id,
      });
      navigate("/");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to stop the session.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  if (isLoading) {
    return <div className="empty-state">Loading recording session...</div>;
  }

  if (!session) {
    return (
      <div className="panel">
        <p className="error-banner">{error ?? "Session not found."}</p>
        <Link className="ghost-button" to="/">
          Back to sessions
        </Link>
      </div>
    );
  }

  return (
    <div className="page-grid recording-layout">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Recording</p>
            <h2>{session.title}</h2>
          </div>
          <StatusBadge status={session.status} />
        </div>

        <dl className="summary-grid">
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(session.durationMs)}</dd>
          </div>
          <div>
            <dt>Segments</dt>
            <dd>{session.segments.length}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{session.status}</dd>
          </div>
        </dl>

        <ControlBar
          status={session.status}
          isBusy={isBusy}
          onPause={() => updateStatus("paused")}
          onResume={() => updateStatus("recording")}
          onStop={handleStop}
        />

        <p className="helper-text">
          Mock transcript segments are appended every 2 seconds while the session
          is recording.
        </p>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <TranscriptPanel
        segments={session.segments}
        emptyMessage="Recording has started, but no transcript segments have been generated yet."
      />
    </div>
  );
}
