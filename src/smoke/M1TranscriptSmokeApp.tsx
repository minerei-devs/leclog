import { useMemo, useState } from "react";
import { TranscriptPanel } from "../components/TranscriptPanel";
import type { TranscriptSegment } from "../types/session";

function buildLongTranscriptFixture(segmentCount: number): TranscriptSegment[] {
  return Array.from({ length: segmentCount }, (_, index) => {
    const startMs = index * 5_000;
    const hasMarker = index % 127 === 0;

    return {
      id: `m1-smoke-${index}`,
      startMs,
      endMs: startMs + 4_500,
      text: hasMarker
        ? `needle marker ${index}.`
        : `lecture concept ${index} continues without punctuation`,
      isFinal: true,
    };
  });
}

export function M1TranscriptSmokeApp() {
  const segments = useMemo(() => buildLongTranscriptFixture(7_200), []);
  const [activeTimeMs, setActiveTimeMs] = useState(0);
  const [lastSeekMs, setLastSeekMs] = useState<number | null>(null);
  const [manualScrollCount, setManualScrollCount] = useState(0);

  return (
    <main
      className="flex h-screen min-h-0 flex-col gap-3 overflow-hidden bg-slate-100 p-4"
      data-smoke="m1-transcript"
      data-active-ms={activeTimeMs}
      data-last-seek-ms={lastSeekMs ?? ""}
      data-manual-scroll-count={manualScrollCount}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">M1 smoke</p>
          <h1 className="text-lg font-semibold text-slate-950">Transcript Reader v2</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="ghost-button"
            data-smoke="jump-middle"
            onClick={() => setActiveTimeMs(4_318 * 5_000 + 1_000)}
          >
            Middle
          </button>
          <button
            type="button"
            className="ghost-button"
            data-smoke="jump-late"
            onClick={() => setActiveTimeMs(7_199 * 5_000 + 1_000)}
          >
            Late
          </button>
        </div>
      </header>

      <TranscriptPanel
        segments={segments}
        polishedTranscriptText={null}
        emptyMessage="No smoke transcript segments."
        activeTimeMs={activeTimeMs}
        syncActiveTime
        activeView="timeline"
        hideViewTabs
        fillAvailable
        onTimelineUserScroll={() => setManualScrollCount((count) => count + 1)}
        onSeek={(timeMs) => {
          setLastSeekMs(timeMs);
          setActiveTimeMs(timeMs);
        }}
      />
    </main>
  );
}
