import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRecentState } from "../hooks/useRecentState";
import { getErrorMessage } from "../lib/errors";
import { formatDate, formatDuration } from "../lib/format";
import { getSession } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { SessionArtifacts } from "./SessionArtifacts";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

export function SessionDetailPage() {
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setError("Missing session id.");
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    void getSession(sessionId)
      .then(async (result) => {
        if (!isMounted) {
          return;
        }

        setSession(result);
        await updateRecentState({
          lastViewedSessionId: result.id,
        });
      })
      .catch((reason) => {
        if (!isMounted) {
          return;
        }

        setError(getErrorMessage(reason, "Failed to load session detail."));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [sessionId, updateRecentState]);

  if (isLoading) {
    return <div className="empty-state">Loading session detail...</div>;
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
            <p className="eyebrow">Session detail</p>
            <h2>{session.title}</h2>
          </div>
          <StatusBadge status={session.status} />
        </div>

        <dl className="summary-grid">
          <div>
            <dt>Created</dt>
            <dd>{formatDate(session.createdAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDate(session.updatedAt)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(session.durationMs)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{session.captureSource === "systemAudio" ? "System audio" : "Microphone"}</dd>
          </div>
        </dl>

        {session.captureTargetLabel ? (
          <p className="helper-text">Capture target: {session.captureTargetLabel}</p>
        ) : null}

        <SessionArtifacts session={session} />

        <Link className="ghost-button" to="/">
          Back to sessions
        </Link>
      </section>

      <TranscriptPanel
        segments={session.segments}
        emptyMessage="No transcript segments were saved for this session."
      />
    </div>
  );
}
