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
  const sentenceChunks = useMemo(() => buildTranscriptSentenceChunks(segments), [segments]);
  const rawTranscript = useMemo(
    () => joinTranscriptSentenceChunks(sentenceChunks),
    [sentenceChunks],
  );
  const copyTarget = polishedTranscriptText?.trim() || rawTranscript;

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
    <section className="panel">
      <div className="panel-header">
        <h2>Transcript</h2>
        <div className="panel-header-actions">
          <p>{sentenceChunks.length} sentence(s)</p>
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
          {polishedTranscriptText?.trim() ? (
            <section className="panel-subsection transcript-merged-block">
              <div className="panel-subsection-header">
                <h3>Polished transcript</h3>
                <p>Paragraphized, cleaned up, and ready to share.</p>
              </div>
              <pre className="transcript-merged-text transcript-polished-text">
                {polishedTranscriptText}
              </pre>
            </section>
          ) : null}

          <section className="panel-subsection transcript-merged-block">
            <div className="panel-subsection-header">
              <h3>Raw transcript</h3>
              <p>Sentence chunks joined directly from the timeline.</p>
            </div>
            <pre className="transcript-merged-text">{rawTranscript}</pre>
          </section>

          <div className="segment-list">
            {sentenceChunks.map((chunk) => (
              <article
                key={chunk.id}
                className={`segment-card ${chunk.isResolved ? "" : "segment-card-muted"}`}
              >
                <div className="segment-meta">
                  <span>
                    {chunk.isResolved
                      ? `${formatDuration(chunk.startMs)} - ${formatDuration(chunk.endMs)}`
                      : `~${formatDuration(chunk.startMs)} - ~${formatDuration(chunk.endMs)}`}
                  </span>
                  <span>{chunk.isResolved ? "ready" : "draft / unresolved"}</span>
                </div>
                <p>{chunk.text}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
