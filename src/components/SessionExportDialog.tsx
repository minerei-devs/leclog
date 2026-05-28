import { Check, Copy, Download, FileText, FolderSearch, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage } from "@/lib/errors";
import { formatBytes, formatDuration } from "@/lib/format";
import { getCaptureSourceLabel, joinTranscriptSegments } from "@/lib/session";
import { exportSessionDeliverable, revealResource } from "@/lib/tauri";
import type {
  LectureSession,
  SessionExportFormat,
  SessionExportResult,
  TranscriptExportLayer,
} from "@/types/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SessionExportDialogProps {
  session: LectureSession;
  open: boolean;
  onClose: () => void;
}

interface ExportFormatOption {
  value: SessionExportFormat;
  label: string;
  disabled?: boolean;
  reason?: string;
}

const humanFormatLabels: Record<SessionExportFormat, string> = {
  txt: "TXT",
  markdown: "Markdown",
  srt: "SRT",
  vtt: "VTT",
  json: "JSON",
  lectureNotes: "Notes MD",
};

const exportExtensions: Record<SessionExportFormat, string> = {
  txt: "txt",
  markdown: "md",
  srt: "srt",
  vtt: "vtt",
  json: "json",
  lectureNotes: "md",
};

function slugLabel(value: string) {
  const slug = value
    .trim()
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lecture-session";
}

function defaultOutputName(
  session: LectureSession,
  format: SessionExportFormat,
  layer: TranscriptExportLayer,
) {
  const suffix =
    format === "lectureNotes"
      ? "lecture-notes"
      : format === "json"
        ? "session"
        : format === "srt" || format === "vtt"
          ? "captions"
          : layer;
  return `${slugLabel(session.title)}-${suffix}.${exportExtensions[format]}`;
}

function hasCaptionSegments(session: LectureSession) {
  return session.segments.some((segment) => segment.text.trim().length > 0);
}

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
}

function previewText(
  session: LectureSession,
  format: SessionExportFormat,
  layer: TranscriptExportLayer,
  includeMetadata: boolean,
  includeTimestamps: boolean,
) {
  if (format === "json") {
    return JSON.stringify(
      {
        schemaVersion: 1,
        session: {
          title: session.title,
          durationMs: session.durationMs,
          captureSource: session.captureSource,
        },
        transcript: {
          segments: session.segments.slice(0, 2),
          polishedText: session.polishedTranscriptText ? "..." : null,
        },
      },
      null,
      2,
    );
  }

  if (format === "srt") {
    const [first] = session.segments.filter((segment) => segment.text.trim());
    return first
      ? `1\n00:00:00,000 --> 00:00:04,000\n${first.text.trim()}`
      : "No timestamped segments available.";
  }

  if (format === "vtt") {
    const [first] = session.segments.filter((segment) => segment.text.trim());
    return first
      ? `WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n${first.text.trim()}`
      : "No timestamped segments available.";
  }

  const transcript =
    layer === "polished"
      ? session.polishedTranscriptText?.trim() || "No polished transcript available."
      : joinTranscriptSegments(session.segments) || "No raw transcript available.";

  if (format === "lectureNotes") {
    return [
      `# ${session.title}`,
      "",
      "## Summary",
      "- ",
      "",
      "## Key Points",
      "- ",
      "",
      "## Transcript Appendix",
      transcript.slice(0, 240),
    ].join("\n");
  }

  if (format === "markdown") {
    const lines = [`# ${session.title}`, ""];
    if (includeMetadata) {
      lines.push("## Metadata", `- Duration: ${formatDuration(session.durationMs)}`, "");
    }
    lines.push("## Transcript", "");
    if (includeTimestamps && layer === "raw") {
      for (const segment of session.segments.slice(0, 3)) {
        if (segment.text.trim()) {
          lines.push(`- [${formatTimestamp(segment.startMs)}] ${segment.text.trim()}`);
        }
      }
    } else {
      lines.push(transcript.slice(0, 320));
    }
    return lines.join("\n");
  }

  return includeMetadata
    ? `${session.title}\nDuration: ${formatDuration(session.durationMs)}\n\n${transcript.slice(0, 360)}`
    : transcript.slice(0, 420);
}

export function SessionExportDialog({ session, open, onClose }: SessionExportDialogProps) {
  const [format, setFormat] = useState<SessionExportFormat>("markdown");
  const [layer, setLayer] = useState<TranscriptExportLayer>(
    session.polishedTranscriptText?.trim() ? "polished" : "raw",
  );
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [includeResourcePaths, setIncludeResourcePaths] = useState(false);
  const [outputName, setOutputName] = useState(defaultOutputName(session, "markdown", layer));
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionExportResult | null>(null);

  const hasPolishedTranscript = Boolean(session.polishedTranscriptText?.trim());
  const hasCaptions = hasCaptionSegments(session);
  const sourceLabel = getCaptureSourceLabel(session.captureSource);

  const formats = useMemo<ExportFormatOption[]>(
    () => [
      { value: "txt", label: "TXT" },
      { value: "markdown", label: "Markdown" },
      {
        value: "srt",
        label: "SRT",
        disabled: !hasCaptions,
        reason: "No timestamped segments",
      },
      {
        value: "vtt",
        label: "VTT",
        disabled: !hasCaptions,
        reason: "No timestamped segments",
      },
      { value: "json", label: "JSON" },
      { value: "lectureNotes", label: "Notes MD" },
    ],
    [hasCaptions],
  );

  const showLayerPicker = format === "txt" || format === "markdown";
  const showTimestampOption = format === "markdown";
  const preview = previewText(session, format, layer, includeMetadata, includeTimestamps);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setResult(null);
  }, [open]);

  useEffect(() => {
    if ((format === "srt" || format === "vtt") && layer !== "raw") {
      setLayer("raw");
    }
    setOutputName(defaultOutputName(session, format, layer));
  }, [format, layer, session]);

  if (!open) {
    return null;
  }

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    setResult(null);
    try {
      const exported = await exportSessionDeliverable({
        sessionId: session.id,
        format,
        layer: showLayerPicker ? layer : "raw",
        includeMetadata,
        includeTimestamps,
        includeResourcePaths,
        outputName,
      });
      setResult(exported);
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to export this session."));
    } finally {
      setIsExporting(false);
    }
  }

  async function handleCopyPath() {
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard.writeText(result.path);
    } catch {
      setError("Failed to copy the export path.");
    }
  }

  async function handleReveal() {
    if (!result) {
      return;
    }
    try {
      await revealResource(result.path);
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to reveal this export."));
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4 py-6">
      <section className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="eyebrow">Export deliverables</p>
            <h3 className="mt-0.5 truncate text-base font-semibold text-slate-950">
              {session.title}
            </h3>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {sourceLabel} · {session.transcriptPhase} · {formatDuration(session.durationMs)}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close export" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </header>

        <div className="grid min-h-0 gap-4 overflow-y-auto px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
          <div className="grid content-start gap-4">
            <section className="grid gap-1.5">
              <p className="text-xs font-semibold text-slate-700">Format</p>
              <div className="inline-flex min-w-0 flex-wrap rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                {formats.map((item) => {
                  const selected = format === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={[
                        "h-8 rounded-md px-2.5 text-xs font-semibold transition-colors",
                        selected
                          ? "bg-slate-950 text-white shadow-sm"
                          : "text-slate-600 hover:bg-white hover:text-slate-950",
                        item.disabled ? "cursor-not-allowed opacity-45" : "",
                      ].join(" ")}
                      disabled={item.disabled}
                      title={item.disabled ? item.reason : `Export ${item.label}`}
                      aria-pressed={selected}
                      onClick={() => setFormat(item.value)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              {!hasCaptions ? (
                <p className="text-[11px] text-slate-500">SRT/VTT require timestamped transcript segments.</p>
              ) : null}
            </section>

            {showLayerPicker ? (
              <section className="grid gap-1.5">
                <p className="text-xs font-semibold text-slate-700">Transcript layer</p>
                <div className="inline-flex w-fit rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                  {[
                    { value: "polished" as const, label: "Polished", disabled: !hasPolishedTranscript, reason: "No polished transcript" },
                    { value: "raw" as const, label: "Raw" },
                    { value: "corrected" as const, label: "Corrected", disabled: true, reason: "Correction editing is not available yet" },
                  ].map((item) => {
                    const selected = layer === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        className={[
                          "h-8 rounded-md px-2.5 text-xs font-semibold transition-colors",
                          selected
                            ? "bg-slate-950 text-white shadow-sm"
                            : "text-slate-600 hover:bg-white hover:text-slate-950",
                          item.disabled ? "cursor-not-allowed opacity-45" : "",
                        ].join(" ")}
                        disabled={item.disabled}
                        title={item.disabled ? item.reason : `${item.label} transcript`}
                        aria-pressed={selected}
                        onClick={() => setLayer(item.value)}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {format === "json"
                  ? "JSON exports all available transcript layers and session metadata."
                  : format === "lectureNotes"
                    ? "Lecture notes use polished text when available and raw text as fallback."
                    : "Caption exports use timestamped raw transcript segments."}
              </p>
            )}

            <section className="grid gap-2">
              <p className="text-xs font-semibold text-slate-700">Options</p>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span>Include session metadata</span>
                <input
                  type="checkbox"
                  checked={includeMetadata}
                  onChange={(event) => setIncludeMetadata(event.target.checked)}
                />
              </label>
              {showTimestampOption ? (
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <span>Include timestamps</span>
                  <input
                    type="checkbox"
                    checked={includeTimestamps}
                    onChange={(event) => setIncludeTimestamps(event.target.checked)}
                  />
                </label>
              ) : null}
              <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span>Include resource paths</span>
                <input
                  type="checkbox"
                  checked={includeResourcePaths}
                  onChange={(event) => setIncludeResourcePaths(event.target.checked)}
                />
              </label>
            </section>

            <label className="grid gap-1.5">
              <span className="text-xs font-semibold text-slate-700">Output name</span>
              <Input
                value={outputName}
                className="h-9 border-slate-300 bg-white"
                onChange={(event) => setOutputName(event.target.value)}
              />
            </label>
          </div>

          <aside className="grid min-h-0 content-start gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
                <FileText className="size-3.5 text-slate-500" />
                <p className="text-xs font-semibold text-slate-700">Preview</p>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-[11px] leading-5 text-slate-700">
                {preview}
              </pre>
            </div>

            {result ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-950">
                  <Check className="size-4" />
                  Export complete
                </div>
                <p className="mt-1 truncate text-xs text-emerald-800" title={result.path}>
                  {result.fileName} · {formatBytes(result.sizeBytes)}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleReveal()}>
                    <FolderSearch className="size-3.5" />
                    Reveal
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyPath()}>
                    <Copy className="size-3.5" />
                    Copy path
                  </Button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}
          </aside>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={isExporting} onClick={() => void handleExport()}>
            <Download className="size-4" />
            {isExporting ? "Exporting..." : `Export ${humanFormatLabels[format]}`}
          </Button>
        </footer>
      </section>
    </div>
  );
}
