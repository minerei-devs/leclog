import { useEffect, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useRecentState } from "../hooks/useRecentState";
import { useSessionPolling } from "../hooks/useSessionPolling";
import { getErrorMessage } from "../lib/errors";
import { formatDate, formatDuration } from "../lib/format";
import { getCaptureSourceLabel } from "../lib/session";
import { deleteSession, getSession, polishSessionTranscript, updateSessionTitle } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionArtifacts } from "./SessionArtifacts";
import { SessionAudioReviewBar, type AudioSeekRequest } from "./SessionAudioReviewBar";
import { SessionStatsStrip } from "./SessionStatsStrip";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

type SessionDetailTab = "content" | "timeline" | "resources" | "detail";

export function SessionDetailPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SessionDetailTab>("content");
  const [activeTimeMs, setActiveTimeMs] = useState<number | null>(null);
  const [seekRequest, setSeekRequest] = useState<AudioSeekRequest | null>(null);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab("content");
    setActiveTimeMs(null);
    setSeekRequest(null);
    setFollowPlayback(true);
    setIsEditingTitle(false);
    setTitleError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!isEditingTitle) {
      setTitleDraft(session?.title ?? "");
      setTitleError(null);
    }
  }, [isEditingTitle, session?.id, session?.title]);

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

  async function handleSaveTitle() {
    if (!session) {
      return;
    }

    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleError("Session title cannot be empty.");
      return;
    }

    if (nextTitle === session.title) {
      setTitleDraft(session.title);
      setTitleError(null);
      setIsEditingTitle(false);
      return;
    }

    setTitleError(null);
    setIsSavingTitle(true);
    try {
      const updated = await updateSessionTitle(session.id, nextTitle);
      setSession(updated);
      setTitleDraft(updated.title);
      setIsEditingTitle(false);
      window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
    } catch (reason) {
      setTitleError(getErrorMessage(reason, "Failed to update the session title."));
    } finally {
      setIsSavingTitle(false);
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
    { id: "content" as const, label: "Content" },
    { id: "timeline" as const, label: "Timeline" },
    { id: "resources" as const, label: "Resources" },
    { id: "detail" as const, label: "Detail" },
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
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <section className="shrink-0 border-b border-slate-200/80">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">Session detail</p>
            <div className="mt-1 flex min-w-0 items-start gap-1.5">
              <div className="min-w-0 flex-1">
                {isEditingTitle ? (
                  <>
                    <Input
                      value={titleDraft}
                      className="h-9 rounded-lg border-slate-300 bg-white text-lg font-semibold tracking-tight text-slate-950"
                      aria-label="Session title"
                      disabled={isSavingTitle}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        setTitleDraft(event.target.value);
                        setTitleError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSaveTitle();
                        }
                        if (event.key === "Escape") {
                          setTitleDraft(session.title);
                          setTitleError(null);
                          setIsEditingTitle(false);
                        }
                      }}
                    />
                    {titleError ? (
                      <p className="mt-1 text-xs text-red-600">{titleError}</p>
                    ) : null}
                  </>
                ) : (
                  <h2 className="truncate text-lg font-semibold tracking-tight text-slate-950">
                    {session.title}
                  </h2>
                )}
              </div>
              {isEditingTitle ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Save title"
                    title="Save title"
                    disabled={isSavingTitle}
                    onClick={() => void handleSaveTitle()}
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Cancel title edit"
                    title="Cancel title edit"
                    disabled={isSavingTitle}
                    onClick={() => {
                      setTitleDraft(session.title);
                      setTitleError(null);
                      setIsEditingTitle(false);
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit title"
                  title="Edit title"
                  onClick={() => {
                    setTitleDraft(session.title);
                    setTitleError(null);
                    setIsEditingTitle(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
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

        <nav className="mt-2 flex min-w-0 items-end gap-1" aria-label="Session transcript views">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                "relative h-8 shrink-0 border-b-2 px-3 text-sm font-medium transition-colors",
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

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden pt-3">
        {session.transcriptError ? <p className="error-banner shrink-0">{session.transcriptError}</p> : null}
        {activeTab === "content" ? (
          <TranscriptPanel
            segments={session.segments}
            polishedTranscriptText={session.polishedTranscriptText}
            emptyMessage="No transcript segments were saved for this session."
            canPolish={session.segments.length > 0 && session.transcriptPhase === "ready"}
            isPolishing={isPolishing}
            fillAvailable
            onPolish={() => void handlePolishTranscript()}
          />
        ) : activeTab === "timeline" ? (
          <>
            <div className="flex shrink-0 items-center justify-end">
              <Button
                type="button"
                variant={followPlayback ? "outline" : "ghost"}
                size="sm"
                aria-pressed={followPlayback}
                title={
                  followPlayback
                    ? "Timeline follows the current playback position. Manual scrolling pauses it."
                    : "Resume automatic scrolling to the current playback position."
                }
                disabled={!hasReviewAudio}
                onClick={() => setFollowPlayback((current) => !current)}
              >
                Follow playback
                <span className="ml-1 text-[11px] font-semibold tabular-nums">
                  {followPlayback ? "On" : "Off"}
                </span>
              </Button>
            </div>
            <div className="shrink-0">
              <SessionAudioReviewBar
                session={session}
                currentTimeMs={activeTimeMs}
                seekRequest={seekRequest}
                onTimeChange={setActiveTimeMs}
              />
            </div>
            <TranscriptPanel
              segments={session.segments}
              polishedTranscriptText={session.polishedTranscriptText}
              emptyMessage="No transcript segments were saved for this session."
              canPolish={false}
              activeTimeMs={activeTimeMs}
              syncActiveTime={hasReviewAudio && followPlayback}
              activeView="timeline"
              hideViewTabs
              fillAvailable
              onTimelineUserScroll={() => setFollowPlayback(false)}
              onSeek={
                hasReviewAudio
                  ? (timeMs) => {
                      setFollowPlayback(true);
                      setSeekRequest({ timeMs, requestedAt: Date.now() });
                      setActiveTimeMs(timeMs);
                    }
                  : undefined
              }
            />
          </>
        ) : activeTab === "resources" ? (
          <SessionArtifacts
            session={session}
            fillAvailable
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
          </section>
        )}
      </div>

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
