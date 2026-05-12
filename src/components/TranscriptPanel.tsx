import { Copy, CopyCheck, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDuration } from "../lib/format";
import {
  buildTranscriptSentenceChunks,
  joinTranscriptSentenceChunks,
} from "../lib/session";
import type { TranscriptSegment } from "../types/session";

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  polishedTranscriptText?: string | null;
  emptyMessage: string;
  canPolish?: boolean;
  isPolishing?: boolean;
  onPolish?: () => void;
}

export function TranscriptPanel({
  segments,
  polishedTranscriptText,
  emptyMessage,
  canPolish = false,
  isPolishing = false,
  onPolish,
}: TranscriptPanelProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeView, setActiveView] = useState<"polished" | "raw" | "timeline">(
    polishedTranscriptText?.trim() ? "polished" : "raw",
  );
  const sentenceChunks = useMemo(() => buildTranscriptSentenceChunks(segments), [segments]);
  const rawTranscript = useMemo(
    () => joinTranscriptSentenceChunks(sentenceChunks),
    [sentenceChunks],
  );
  const copyTarget = polishedTranscriptText?.trim() || rawTranscript;
  const hasPolishedTranscript = Boolean(polishedTranscriptText?.trim());
  const resolvedView = activeView === "polished" && !hasPolishedTranscript ? "raw" : activeView;

  async function handleCopyFullTranscript() {
    if (!copyTarget) {
      return;
    }

    try {
      await navigator.clipboard.writeText(copyTarget);
      setCopyState("copied");
      window.setTimeout(() => {
        setCopyState("idle");
      }, 1600);
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section className="transcript-panel panel">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-950">Transcript</h2>
          <p className="mt-0.5 text-xs text-slate-500">{sentenceChunks.length} sentence(s)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onPolish ? (
            <button
              className="ghost-button"
              type="button"
              onClick={onPolish}
              disabled={!canPolish || isPolishing}
            >
              <WandSparkles className="button-icon" size={16} />
              {isPolishing ? "Polishing..." : "Polish transcript"}
            </button>
          ) : null}
          <button
            className="ghost-button"
            type="button"
            onClick={() => void handleCopyFullTranscript()}
            disabled={!copyTarget}
          >
            {copyState === "copied" ? (
              <CopyCheck className="button-icon" size={16} />
            ) : (
              <Copy className="button-icon" size={16} />
            )}
            {copyState === "copied"
              ? "Copied"
              : copyState === "error"
                ? "Copy failed"
                : polishedTranscriptText?.trim()
                  ? "Copy polished transcript"
                  : "Copy full transcript"}
          </button>
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="empty-state compact-empty-state">{emptyMessage}</div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
            {hasPolishedTranscript ? (
              <button
                type="button"
                className={[
                  "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
                  resolvedView === "polished"
                    ? "bg-white text-slate-950 shadow-sm"
                    : "text-slate-600 hover:text-slate-950",
                ].join(" ")}
                onClick={() => setActiveView("polished")}
              >
                Polished
              </button>
            ) : null}
            <button
              type="button"
              className={[
                "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
                resolvedView === "raw"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950",
              ].join(" ")}
              onClick={() => setActiveView("raw")}
            >
              Raw
            </button>
            <button
              type="button"
              className={[
                "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
                resolvedView === "timeline"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950",
              ].join(" ")}
              onClick={() => setActiveView("timeline")}
            >
              Timeline
            </button>
          </div>

          {resolvedView === "polished" ? (
            <pre className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 whitespace-pre-wrap text-slate-800">
              {polishedTranscriptText}
            </pre>
          ) : null}

          {resolvedView === "raw" ? (
            <pre className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 whitespace-pre-wrap text-slate-800">
              {rawTranscript}
            </pre>
          ) : null}

          {resolvedView === "timeline" ? (
            <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white">
              {sentenceChunks.map((chunk) => (
                <article
                  key={chunk.id}
                  className={[
                    "grid gap-1 border-b border-slate-100 px-3 py-2 last:border-b-0",
                    chunk.isResolved ? "" : "bg-slate-50/70",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                    <span className="tabular-nums">
                      {chunk.isResolved
                        ? `${formatDuration(chunk.startMs)} - ${formatDuration(chunk.endMs)}`
                        : `~${formatDuration(chunk.startMs)} - ~${formatDuration(chunk.endMs)}`}
                    </span>
                    <span>{chunk.isResolved ? "ready" : "draft / unresolved"}</span>
                  </div>
                  <p className="text-sm leading-6 text-slate-800">{chunk.text}</p>
                </article>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
