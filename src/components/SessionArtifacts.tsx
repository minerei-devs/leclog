import { Copy, FolderSearch, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { deleteResource, getSession, revealResource, retrySessionProcessing } from "@/lib/tauri";
import type { LectureSession } from "@/types/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SessionArtifactsProps {
  session: LectureSession;
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

function fileName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function SessionArtifacts({ session, onSessionUpdate, onSessionDelete }: SessionArtifactsProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDeleteResources = session.status !== "recording" && session.status !== "processing";

  const rows = useMemo<ArtifactRow[]>(() => {
    const baseRows: ArtifactRow[] = [
      {
        label: "Session folder",
        value: session.sessionDir ?? "",
        kind: "folder",
        revealable: true,
        deletable: canDeleteResources,
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
  }, [canDeleteResources, session]);

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

  async function handleDelete(row: ArtifactRow) {
    const isSessionFolder = row.kind === "folder";
    const message = isSessionFolder
      ? `Delete the whole session "${session.title}" and all local files?`
      : `Delete ${row.label}?`;
    if (!window.confirm(`${message}\n\nThis only removes Leclog app data.`)) {
      return;
    }

    try {
      setBusyAction(`delete:${row.value}`);
      setError(null);
      await deleteResource(row.value, session.id, null);
      if (isSessionFolder) {
        onSessionDelete?.();
        return;
      }

      const updated = await getSession(session.id);
      onSessionUpdate?.(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete this resource.");
    } finally {
      setBusyAction(null);
    }
  }

  const captureCount = session.audioFilePaths.length;
  const processedCount = rows.filter((row) => row.kind === "processed" || row.kind === "transcript").length;

  return (
    <section
      className="session-resources-panel"
      title="Session-level capture files and transcript artifacts. App-wide models, cache, and cleanup live in Settings."
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-2.5 py-1.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950">Session resources</h3>
          <p className="truncate text-[11px] text-slate-500">
            {captureCount} capture file(s), {processedCount} processed artifact(s)
          </p>
        </div>
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
      </div>

      <div className="max-h-[42vh] overflow-y-auto px-2.5">
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
                  title={row.kind === "folder" ? "Delete session" : "Delete resource"}
                  disabled={busyAction === `delete:${row.value}`}
                  onClick={() => void handleDelete(row)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {error ? <p className="border-t border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
