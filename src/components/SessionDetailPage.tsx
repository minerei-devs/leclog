import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRecentState } from "../hooks/useRecentState";
import { useSessionPolling } from "../hooks/useSessionPolling";
import { getErrorMessage } from "../lib/errors";
import { formatDate, formatDuration } from "../lib/format";
import { getCaptureSourceLabel } from "../lib/session";
import { getSession, polishSessionTranscript } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { PanelList } from "./PanelList";
import { SessionArtifacts } from "./SessionArtifacts";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

export function SessionDetailPage() {
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolishing, setIsPolishing] = useState(false);
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

  useSessionPolling({
    sessionId,
    enabled: Boolean(
      session &&
        (session.status === "processing" ||
          session.transcriptPhase === "processing" ||
          session.transcriptPhase === "live"),
    ),
    intervalMs: 1_000,
    onSession: setSession,
    onError: setError,
  });

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

  async function handlePolishTranscript() {
    if (!session) {
      return;
    }

    setError(null);
    setIsPolishing(true);

    try {
      const updated = await polishSessionTranscript(session.id);
      setSession(updated);
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to polish the transcript."));
    } finally {
      setIsPolishing(false);
    }
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

        <PanelList
          rows={[
            {
              label: "Created",
              value: formatDate(session.createdAt),
            },
            {
              label: "Updated",
              value: formatDate(session.updatedAt),
            },
            {
              label: "Duration",
              value: formatDuration(session.durationMs),
            },
            {
              label: "Source",
              value: getCaptureSourceLabel(session.captureSource),
            },
            {
              label: "Transcript status",
              value: session.transcriptPhase,
            },
            ...(session.captureTargetLabel
              ? [{ label: "Capture target", value: session.captureTargetLabel }]
              : []),
          ]}
        />

        <SessionArtifacts session={session} />

        {session.transcriptError ? <p className="error-banner">{session.transcriptError}</p> : null}

        <Link className="ghost-button" to="/">
          Back to sessions
        </Link>
      </section>

      <TranscriptPanel
        segments={session.segments}
        polishedTranscriptText={session.polishedTranscriptText}
        emptyMessage="No transcript segments were saved for this session."
        canPolish={session.segments.length > 0 && session.transcriptPhase === "ready"}
        isPolishing={isPolishing}
        onPolish={() => void handlePolishTranscript()}
      />
    </div>
  );
}
