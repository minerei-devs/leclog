import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useRecentState } from "../hooks/useRecentState";
import { useSessionPolling } from "../hooks/useSessionPolling";
import { getErrorMessage } from "../lib/errors";
import { formatDate, formatDuration } from "../lib/format";
import { getCaptureSourceLabel } from "../lib/session";
import { deleteSession, getSession, polishSessionTranscript } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionArtifacts } from "./SessionArtifacts";
import { SessionStatsStrip } from "./SessionStatsStrip";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

export function SessionDetailPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDeleteSession() {
    if (!session) {
      return;
    }
    if (session.status === "recording") {
      setDeleteError("Pause or stop recording before deleting this session.");
      return;
    }

    setError(null);
    setDeleteError(null);
    setIsDeleting(true);
    try {
      await deleteSession(session.id);
      await updateRecentState({
        activeSessionId: null,
        lastViewedSessionId: null,
      });
      window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
      navigate("/new", { replace: true });
    } catch (reason) {
      setDeleteError(getErrorMessage(reason, "Failed to delete this session."));
    } finally {
      setIsDeleting(false);
    }
  }

  const sourceLabel = getCaptureSourceLabel(session.captureSource);
  const canDeleteSession = session.status !== "recording";
  const detailStats = [
    {
      label: "Duration",
      value: formatDuration(session.durationMs),
      title: "Final captured duration.",
    },
    {
      label: "Phase",
      value: session.transcriptPhase,
      title: "Transcript pipeline state.",
    },
    {
      label: "Source",
      value: sourceLabel,
      title: `Capture source: ${sourceLabel}.`,
    },
    {
      label: "Updated",
      value: formatDate(session.updatedAt),
      title: `Created ${formatDate(session.createdAt)}. Updated ${formatDate(session.updatedAt)}.`,
    },
    ...(session.captureTargetLabel
      ? [
          {
            label: "Target",
            value: session.captureTargetLabel,
            title: session.captureTargetLabel,
          },
        ]
      : []),
  ];

  return (
    <div className="page-grid recording-layout">
      <section className="session-side-panel">
        <div className="session-topline">
          <div className="session-title-stack">
            <p className="eyebrow">Session detail</p>
            <h2>{session.title}</h2>
          </div>
          <div className="session-top-actions">
            <StatusBadge status={session.status} />
            <Button
              type="button"
              variant="destructive"
              size="icon-sm"
              aria-label="Delete session"
              title={
                canDeleteSession
                  ? "Delete this session and all Leclog-managed files."
                  : "Pause recording before deleting."
              }
              disabled={isDeleting}
              onClick={() => {
                setDeleteError(null);
                setIsDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        <SessionStatsStrip items={detailStats} />

        <SessionArtifacts
          session={session}
          onSessionUpdate={setSession}
          onSessionDelete={() => {
            void updateRecentState({
              activeSessionId: null,
              lastViewedSessionId: null,
            });
            navigate("/new", { replace: true });
          }}
        />

        {session.transcriptError ? <p className="error-banner">{session.transcriptError}</p> : null}

        <Link className="ghost-button session-back-link" to="/">
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

      <ConfirmDialog
        open={isDeleteDialogOpen}
        title="Delete session?"
        description={
          canDeleteSession
            ? "This removes the session record and all Leclog-managed files for it. Any active processing task for this session will be canceled first."
            : "This session is actively recording. Pause or stop recording before deleting it."
        }
        details={[
          session.title,
          session.sessionDir ?? "Managed session folder",
        ]}
        confirmLabel="Delete session"
        isBusy={isDeleting}
        confirmDisabled={!canDeleteSession}
        error={deleteError}
        onCancel={() => {
          if (!isDeleting) {
            setIsDeleteDialogOpen(false);
            setDeleteError(null);
          }
        }}
        onConfirm={() => void handleDeleteSession()}
      />
    </div>
  );
}
