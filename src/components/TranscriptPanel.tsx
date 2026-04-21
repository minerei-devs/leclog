import { formatDuration } from "../lib/format";
import type { TranscriptSegment } from "../types/session";

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  emptyMessage: string;
}

export function TranscriptPanel({
  segments,
  emptyMessage,
}: TranscriptPanelProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Transcript</h2>
        <p>{segments.length} segment(s)</p>
      </div>

      {segments.length === 0 ? (
        <div className="empty-state compact-empty-state">{emptyMessage}</div>
      ) : (
        <div className="segment-list">
          {segments.map((segment) => (
            <article key={segment.id} className="segment-card">
              <div className="segment-meta">
                <span>
                  {formatDuration(segment.startMs)} - {formatDuration(segment.endMs)}
                </span>
                <span>{segment.isFinal ? "final" : "draft"}</span>
              </div>
              <p>{segment.text}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
