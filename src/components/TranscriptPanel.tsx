import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  CopyCheck,
  Search,
  WandSparkles,
} from "lucide-react";
import { formatDuration } from "../lib/format";
import {
  buildTranscriptSentenceChunks,
  joinTranscriptSentenceChunks,
} from "../lib/session";
import type { TranscriptSegment } from "../types/session";

type TranscriptView = "polished" | "raw" | "timeline";

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  polishedTranscriptText?: string | null;
  emptyMessage: string;
  canPolish?: boolean;
  isPolishing?: boolean;
  activeTimeMs?: number | null;
  syncActiveTime?: boolean;
  onPolish?: () => void;
  onSeek?: (timeMs: number) => void;
}

interface SearchMatch {
  chunkIndex: number;
  startIndex: number;
}

function buildSearchMatches(
  chunks: ReturnType<typeof buildTranscriptSentenceChunks>,
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const matches: SearchMatch[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    const normalizedText = chunk.text.toLocaleLowerCase();
    let fromIndex = 0;
    let startIndex = normalizedText.indexOf(normalizedQuery, fromIndex);
    while (startIndex !== -1) {
      matches.push({ chunkIndex, startIndex });
      fromIndex = startIndex + normalizedQuery.length;
      startIndex = normalizedText.indexOf(normalizedQuery, fromIndex);
    }
  });
  return matches;
}

function HighlightedText({
  text,
  query,
  activeStartIndex = null,
}: {
  text: string;
  query: string;
  activeStartIndex?: number | null;
}) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return <>{text}</>;
  }

  const normalizedText = text.toLocaleLowerCase();
  const normalizedQuery = trimmedQuery.toLocaleLowerCase();
  const queryLength = normalizedQuery.length;
  const parts: Array<{ text: string; isMatch: boolean; startIndex: number }> = [];
  let cursor = 0;
  let matchStart = normalizedText.indexOf(normalizedQuery, cursor);

  while (matchStart !== -1) {
    if (matchStart > cursor) {
      parts.push({
        text: text.slice(cursor, matchStart),
        isMatch: false,
        startIndex: cursor,
      });
    }

    parts.push({
      text: text.slice(matchStart, matchStart + queryLength),
      isMatch: true,
      startIndex: matchStart,
    });

    cursor = matchStart + queryLength;
    matchStart = normalizedText.indexOf(normalizedQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push({
      text: text.slice(cursor),
      isMatch: false,
      startIndex: cursor,
    });
  }

  return (
    <>
      {parts.map((part) =>
        part.isMatch ? (
          <mark
            key={`${part.startIndex}-${part.text}`}
            className={[
              "rounded px-0.5 text-slate-950",
              activeStartIndex === part.startIndex
                ? "bg-orange-300 ring-1 ring-orange-400"
                : "bg-amber-200",
            ].join(" ")}
          >
            {part.text}
          </mark>
        ) : (
          <span key={`${part.startIndex}-${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function TranscriptPanel({
  segments,
  polishedTranscriptText,
  emptyMessage,
  canPolish = false,
  isPolishing = false,
  activeTimeMs = null,
  syncActiveTime = false,
  onPolish,
  onSeek,
}: TranscriptPanelProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeView, setActiveView] = useState<TranscriptView>(
    polishedTranscriptText?.trim() ? "polished" : "raw",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const sentenceChunks = useMemo(() => buildTranscriptSentenceChunks(segments), [segments]);
  const rawTranscript = useMemo(
    () => joinTranscriptSentenceChunks(sentenceChunks),
    [sentenceChunks],
  );
  const copyTarget = polishedTranscriptText?.trim() || rawTranscript;
  const hasPolishedTranscript = Boolean(polishedTranscriptText?.trim());
  const resolvedView = activeView === "polished" && !hasPolishedTranscript ? "raw" : activeView;
  const searchMatches = useMemo(
    () => buildSearchMatches(sentenceChunks, searchQuery),
    [searchQuery, sentenceChunks],
  );
  const matchingChunkIndexes = useMemo(
    () => new Set(searchMatches.map((match) => match.chunkIndex)),
    [searchMatches],
  );
  const activeSearchMatch = searchMatches[activeMatchIndex] ?? null;
  const activeSearchChunkIndex = activeSearchMatch?.chunkIndex ?? null;
  const activeTimeChunkIndex = useMemo(() => {
    if (activeTimeMs === null) {
      return null;
    }
    const chunkIndex = sentenceChunks.findIndex(
      (chunk) => activeTimeMs >= chunk.startMs && activeTimeMs <= chunk.endMs,
    );
    return chunkIndex === -1 ? null : chunkIndex;
  }, [activeTimeMs, sentenceChunks]);
  const canSearchRows = sentenceChunks.length > 0 && resolvedView !== "polished";
  const rowVirtualizer = useVirtualizer({
    count: sentenceChunks.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 92,
    overscan: 8,
  });

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [searchQuery, resolvedView]);

  useEffect(() => {
    if (!canSearchRows || activeSearchChunkIndex === null) {
      return;
    }

    rowVirtualizer.scrollToIndex(activeSearchChunkIndex, { align: "center" });
  }, [activeSearchChunkIndex, canSearchRows, rowVirtualizer]);

  useEffect(() => {
    if (
      !syncActiveTime ||
      !canSearchRows ||
      searchQuery.trim() ||
      activeTimeChunkIndex === null
    ) {
      return;
    }

    rowVirtualizer.scrollToIndex(activeTimeChunkIndex, { align: "center" });
  }, [activeTimeChunkIndex, canSearchRows, rowVirtualizer, searchQuery, syncActiveTime]);

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

  function moveSearch(delta: number) {
    if (searchMatches.length === 0) {
      return;
    }

    setActiveMatchIndex((current) => {
      const next = current + delta;
      if (next < 0) {
        return searchMatches.length - 1;
      }
      if (next >= searchMatches.length) {
        return 0;
      }
      return next;
    });
  }

  function renderVirtualTranscriptRows(mode: "raw" | "timeline") {
    return (
      <div
        ref={scrollParentRef}
        className="relative max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white"
      >
        <div
          className="relative w-full"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const chunk = sentenceChunks[virtualRow.index];
            const isSearchHit = matchingChunkIndexes.has(virtualRow.index);
            const isActiveSearchHit = activeSearchChunkIndex === virtualRow.index;
            const isActiveTimeHit = activeTimeChunkIndex === virtualRow.index;

            return (
              <article
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className={[
                  "absolute left-0 top-0 w-full border-b border-slate-100 px-3 py-2.5 last:border-b-0",
                  isActiveSearchHit
                    ? "bg-amber-50"
                    : isActiveTimeHit
                      ? "bg-blue-50"
                      : isSearchHit
                        ? "bg-amber-50/45"
                        : chunk.isResolved
                          ? "bg-white"
                          : "bg-slate-50/70",
                  onSeek ? "cursor-pointer hover:bg-slate-50" : "",
                ].join(" ")}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                role={onSeek ? "button" : undefined}
                tabIndex={onSeek ? 0 : undefined}
                title={onSeek ? "Seek audio to this transcript row" : undefined}
                onClick={() => onSeek?.(chunk.startMs)}
                onKeyDown={(event) => {
                  if (!onSeek || (event.key !== "Enter" && event.key !== " ")) {
                    return;
                  }
                  event.preventDefault();
                  onSeek(chunk.startMs);
                }}
              >
                <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                  <span className="tabular-nums">
                    {mode === "timeline" || chunk.isResolved
                      ? `${formatDuration(chunk.startMs)} - ${formatDuration(chunk.endMs)}`
                      : `~${formatDuration(chunk.startMs)} - ~${formatDuration(chunk.endMs)}`}
                  </span>
                  {mode === "timeline" ? (
                    <span>{chunk.isResolved ? "ready" : "draft / unresolved"}</span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-800">
                  <HighlightedText
                    text={chunk.text}
                    query={searchQuery}
                    activeStartIndex={
                      isActiveSearchHit ? activeSearchMatch?.startIndex ?? null : null
                    }
                  />
                </p>
              </article>
            );
          })}
        </div>
      </div>
    );
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
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
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

            <div
              className="flex min-w-[260px] flex-1 items-center justify-end gap-1"
              title={canSearchRows ? "Search timestamped transcript rows" : "Search is available in Raw and Timeline views"}
            >
              <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2">
                <Search className="size-3.5 shrink-0 text-slate-400" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  disabled={!canSearchRows}
                  placeholder="Search transcript"
                  className="min-w-0 flex-1 bg-transparent text-xs text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
                />
                <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                  {searchQuery.trim()
                    ? `${searchMatches.length === 0 ? 0 : activeMatchIndex + 1}/${searchMatches.length}`
                    : `${sentenceChunks.length}`}
                </span>
              </div>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canSearchRows || searchMatches.length === 0}
                title="Previous result"
                onClick={() => moveSearch(-1)}
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canSearchRows || searchMatches.length === 0}
                title="Next result"
                onClick={() => moveSearch(1)}
              >
                <ChevronDown className="size-3.5" />
              </button>
            </div>
          </div>

          {resolvedView === "polished" ? (
            <pre className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 whitespace-pre-wrap text-slate-800">
              {polishedTranscriptText}
            </pre>
          ) : null}

          {resolvedView === "raw" ? renderVirtualTranscriptRows("raw") : null}

          {resolvedView === "timeline" ? renderVirtualTranscriptRows("timeline") : null}
        </>
      )}
    </section>
  );
}
