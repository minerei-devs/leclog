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
import { SessionAudioReviewBar, type AudioSeekRequest } from "./SessionAudioReviewBar";
import { SessionStatsStrip } from "./SessionStatsStrip";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

type SessionDetailTab = "transcript" | "resources" | "details";

export function SessionDetailPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SessionDetailTab>("transcript");
  const [activeTimeMs, setActiveTimeMs] = useState<number | null>(null);
  const [seekRequest, setSeekRequest] = useState<AudioSeekRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab("transcript");
    setActiveTimeMs(null);
    setSeekRequest(null);
  }, [sessionId]);

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
  const hasReviewAudio = Boolean(
    session.normalizedAudioPath ||
      session.livePreviewAudioPath ||
      session.audioFilePaths.length > 0,
  );
  const tabs = [
    { id: "transcript" as const, label: "Transcript" },
    { id: "resources" as const, label: "Resources" },
    { id: "details" as const, label: "Details" },
  ];
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
    <div className="grid gap-3">
      <section className="sticky top-0 z-30 -mx-5 -mt-5 border-b border-slate-200/80 bg-slate-50/90 px-5 pt-4 backdrop-blur-xl">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">Session detail</p>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-slate-950">
              {session.title}
            </h2>
            <p className="mt-1 truncate text-xs text-slate-500" title={`${sourceLabel} · ${formatDuration(session.durationMs)} · ${session.transcriptPhase}`}>
              {sourceLabel} · {formatDuration(session.durationMs)} · {session.transcriptPhase}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
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

        <nav className="mt-3 flex min-w-0 items-end gap-1 overflow-x-auto" aria-label="Session detail sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                "relative h-9 shrink-0 border-b-2 px-3 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "border-slate-950 text-slate-950"
                  : "border-transparent text-slate-500 hover:text-slate-900",
              ].join(" ")}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </section>

      {activeTab === "transcript" ? (
        <div className="grid gap-2">
          <SessionAudioReviewBar
            session={session}
            currentTimeMs={activeTimeMs}
            seekRequest={seekRequest}
            onTimeChange={setActiveTimeMs}
          />
          <TranscriptPanel
            segments={session.segments}
            polishedTranscriptText={session.polishedTranscriptText}
            emptyMessage="No transcript segments were saved for this session."
            canPolish={session.segments.length > 0 && session.transcriptPhase === "ready"}
            isPolishing={isPolishing}
            activeTimeMs={activeTimeMs}
            syncActiveTime={hasReviewAudio}
            onPolish={() => void handlePolishTranscript()}
            onSeek={
              hasReviewAudio
                ? (timeMs) => {
                    setSeekRequest({ timeMs, requestedAt: Date.now() });
                    setActiveTimeMs(timeMs);
                  }
                : undefined
            }
          />
        </div>
      ) : activeTab === "resources" ? (
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
      ) : (
        <section className="session-side-panel">
          <SessionStatsStrip items={detailStats} />
          {session.transcriptError ? <p className="error-banner">{session.transcriptError}</p> : null}
        </section>
      )}

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
