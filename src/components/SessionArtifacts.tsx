import { Copy, Eraser, FolderSearch, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { deleteResource, deleteSession, getSession, revealResource, retrySessionProcessing } from "@/lib/tauri";
import type { LectureSession } from "@/types/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface SessionArtifactsProps {
  session: LectureSession;
  fillAvailable?: boolean;
  onSessionUpdate?: (session: LectureSession) => void;
  onSessionDelete?: () => void;
}

interface ArtifactRow {
  label: string;
  value: string;
  kind: string;
  revealable: boolean;
  deletable: boolean;
}

type PendingDelete =
  | { kind: "session" }
  | { kind: "resource"; row: ArtifactRow }
  | null;

function fileName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function SessionArtifacts({
  session,
  fillAvailable = false,
  onSessionUpdate,
  onSessionDelete,
}: SessionArtifactsProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const canDeleteSession = session.status !== "recording";
  const canDeleteResources = canDeleteSession && session.transcriptPhase !== "processing";

  const rows = useMemo<ArtifactRow[]>(() => {
    const baseRows: ArtifactRow[] = [
      {
        label: "Session folder",
        value: session.sessionDir ?? "",
        kind: "folder",
        revealable: true,
        deletable: canDeleteSession,
      },
      {
        label: "Active",
        value: session.activeAudioFilePath ?? "",
        kind: "audio",
        revealable: true,
        deletable: canDeleteResources,
      },
      {
        label: "Normalized",
        value: session.normalizedAudioPath ?? "",
        kind: "processed",
        revealable: true,
        deletable: canDeleteResources,
      },
      {
        label: "Live preview",
        value: session.livePreviewAudioPath ?? "",
        kind: "preview",
        revealable: true,
        deletable: canDeleteResources,
      },
      {
        label: "Raw transcript",
        value: session.processedTranscriptPath ?? "",
        kind: "transcript",
        revealable: true,
        deletable: canDeleteResources,
      },
      {
        label: "Polished",
        value: session.polishedTranscriptPath ?? "",
        kind: "transcript",
        revealable: true,
        deletable: canDeleteResources,
      },
      {
        label: "Target",
        value: session.captureTargetLabel ?? "",
        kind: "metadata",
        revealable: false,
        deletable: false,
      },
      {
        label: "MIME type",
        value: session.audioMimeType ?? "",
        kind: "metadata",
        revealable: false,
        deletable: false,
      },
    ];

    return [
      ...baseRows,
      ...session.audioFilePaths.map((path, index) => ({
        label: `Capture ${index + 1}`,
        value: path,
        kind: "audio",
        revealable: true,
        deletable: canDeleteResources,
      })),
    ].filter((row) => row.value.trim().length > 0);
  }, [canDeleteResources, canDeleteSession, session]);

  if (rows.length === 0) {
    return null;
  }

  async function handleCopy(path: string) {
    try {
      setError(null);
      await navigator.clipboard.writeText(path);
    } catch {
      setError("Failed to copy the path.");
    }
  }

  async function handleReveal(path: string) {
    try {
      setBusyAction(path);
      setError(null);
      await revealResource(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to reveal the file.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReprocess() {
    try {
      setBusyAction("reprocess");
      setError(null);
      const updated = await retrySessionProcessing(session.id);
      onSessionUpdate?.(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to reprocess this session.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteSession() {
    if (session.status === "recording") {
      setError("Pause or stop recording before deleting this session.");
      return;
    }

    try {
      setBusyAction("delete-session");
      setError(null);
      await deleteSession(session.id);
      window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
      onSessionDelete?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete this session.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleClear(row: ArtifactRow) {
    const isSessionFolder = row.kind === "folder";
    if (isSessionFolder) {
      setError(null);
      setPendingDelete({ kind: "session" });
      return;
    }

    setError(null);
    setPendingDelete({ kind: "resource", row });
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) {
      return;
    }

    if (pendingDelete.kind === "session") {
      await handleDeleteSession();
      return;
    }

    const row = pendingDelete.row;
    try {
      setBusyAction(`clear:${row.value}`);
      setError(null);
      await deleteResource(row.value, session.id, null);
      const updated = await getSession(session.id);
      onSessionUpdate?.(updated);
      setPendingDelete(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to clear this resource.");
    } finally {
      setBusyAction(null);
    }
  }

  const captureCount = session.audioFilePaths.length;
  const processedCount = rows.filter((row) => row.kind === "processed" || row.kind === "transcript").length;

  return (
    <section
      className={[
        "session-resources-panel",
        fillAvailable ? "flex h-full min-h-0 flex-col overflow-hidden" : "",
      ].join(" ")}
      title="Session-level capture files and transcript artifacts. App-wide models, cache, and cleanup live in Settings."
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-2.5 py-1.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950">Resources</h3>
          <p className="truncate text-[11px] text-slate-500">
            {captureCount} capture file(s), {processedCount} processed artifact(s)
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Run normalize, transcribe, merge, and polish again for this session."
            disabled={busyAction === "reprocess" || session.audioFilePaths.length === 0}
            onClick={() => void handleReprocess()}
          >
            <RotateCcw className="size-3.5" />
            Reprocess
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            title="Clear this session and all Leclog-managed files for it."
            disabled={busyAction === "delete-session" || busyAction?.startsWith("clear:")}
            onClick={() => {
              setError(null);
              setPendingDelete({ kind: "session" });
            }}
          >
            <Eraser className="size-3.5" />
            Clear all
          </Button>
        </div>
      </div>

      <div className={fillAvailable ? "min-h-0 flex-1 overflow-y-auto px-2.5" : "max-h-[42vh] overflow-y-auto px-2.5"}>
        {rows.map((row) => (
          <div
            key={`${row.label}-${row.value}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-slate-100 py-1.5 last:border-b-0"
            title={row.value}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="rounded-md border-slate-200 bg-slate-50 px-1.5 text-[10px] text-slate-600">
                  {row.kind}
                </Badge>
                <p className="min-w-[88px] truncate text-xs font-medium text-slate-950">{row.label}</p>
                <span className="truncate text-xs text-slate-500">
                  {row.revealable ? fileName(row.value) : row.value}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon-sm" title="Copy path" onClick={() => void handleCopy(row.value)}>
                <Copy className="size-3.5" />
              </Button>
              {row.revealable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Reveal"
                  disabled={busyAction === row.value}
                  onClick={() => void handleReveal(row.value)}
                >
                  <FolderSearch className="size-3.5" />
                </Button>
              ) : null}
              {row.deletable ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  title={row.kind === "folder" ? "Clear all session resources" : "Clear resource"}
                  disabled={busyAction === `clear:${row.value}`}
                  onClick={() => void handleClear(row)}
                >
                  {row.kind === "folder" ? <Trash2 className="size-3.5" /> : <Eraser className="size-3.5" />}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {error ? <p className="border-t border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "resource" ? `Clear ${pendingDelete.row.label}?` : "Clear session resources?"}
        description={
          pendingDelete?.kind === "resource"
            ? "This clears only this Leclog-managed resource from the session. Source files outside app data are not touched."
            : canDeleteSession
              ? "This clears the session record and all Leclog-managed files for it. Any active processing task for this session will be canceled first."
              : "This session is actively recording. Pause or stop recording before clearing it."
        }
        details={
          pendingDelete?.kind === "resource"
            ? [pendingDelete.row.value]
            : [session.title, session.sessionDir ?? "Managed session folder"]
        }
        confirmLabel={pendingDelete?.kind === "resource" ? "Clear resource" : "Clear all"}
        isBusy={busyAction?.startsWith("delete") || busyAction?.startsWith("clear") || false}
        confirmDisabled={pendingDelete?.kind === "session" && !canDeleteSession}
        error={error}
        onCancel={() => {
          if (!busyAction?.startsWith("delete") && !busyAction?.startsWith("clear")) {
            setPendingDelete(null);
            setError(null);
          }
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </section>
  );
}
