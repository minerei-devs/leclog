import type { CaptureSource, LectureSession, TranscriptSegment } from "../types/session";

interface TranscriptSentenceChunk {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  isResolved: boolean;
}

export interface TranscriptSearchMatch {
  chunkIndex: number;
  startIndex: number;
}

const FALLBACK_SEGMENT_DURATION_MS = 4_000;
const MAX_SEGMENTS_PER_TRANSCRIPT_CHUNK = 6;
const MAX_TRANSCRIPT_CHUNK_CHARS = 720;

export function getLiveDurationMs(
  session: Pick<LectureSession, "durationMs" | "lastResumedAt" | "status">,
  now = Date.now(),
) {
  if (session.status !== "recording" || !session.lastResumedAt) {
    return session.durationMs;
  }

  const resumedAtMs = new Date(session.lastResumedAt).getTime();
  if (Number.isNaN(resumedAtMs)) {
    return session.durationMs;
  }

  return session.durationMs + Math.max(0, now - resumedAtMs);
}

export function getCaptureSourceLabel(captureSource: CaptureSource) {
  if (captureSource === "systemAudio") {
    return "System audio";
  }

  if (captureSource === "importedMedia") {
    return "Imported media";
  }

  return "Microphone";
}

export function getSessionHref(session: Pick<LectureSession, "id" | "status" | "captureSource">) {
  if (session.status === "done" || session.captureSource === "importedMedia") {
    return `/session/${session.id}`;
  }

  return `/recording/${session.id}`;
}

export function joinTranscriptSegments(
  segments: Pick<TranscriptSegment, "text">[],
) {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

function endsWithSentencePunctuation(text: string) {
  return /[。！？.!?]["'」』）)]*$/.test(text.trimEnd());
}

function mergeTranscriptText(left: string, right: string) {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const nextStartsWithPunctuation = /^[、。！？,.!?」』）)]/.test(right);
  const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);

  if (nextStartsWithPunctuation) {
    return `${left}${right}`;
  }

  if (needsSpace) {
    return `${left} ${right}`;
  }

  return `${left}${right}`;
}

function resolveSegmentTiming(
  segment: TranscriptSegment,
  fallbackStartMs: number,
) {
  const rawStartMs = Number(segment.startMs);
  const hasValidStart = Number.isFinite(rawStartMs) && rawStartMs >= 0;
  const startMs =
    hasValidStart && (rawStartMs > 0 || fallbackStartMs === 0)
      ? rawStartMs
      : fallbackStartMs;

  const rawEndMs = Number(segment.endMs);
  const endMs =
    Number.isFinite(rawEndMs) && rawEndMs > startMs
      ? rawEndMs
      : startMs + FALLBACK_SEGMENT_DURATION_MS;

  return { startMs, endMs };
}

export function buildTranscriptSentenceChunks(
  segments: TranscriptSegment[],
): TranscriptSentenceChunk[] {
  const chunks: TranscriptSentenceChunk[] = [];
  let activeChunk: TranscriptSentenceChunk | null = null;
  let activeChunkSegmentCount = 0;
  let fallbackStartMs = 0;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }

    const timing = resolveSegmentTiming(segment, fallbackStartMs);
    fallbackStartMs = Math.max(fallbackStartMs, timing.endMs);

    if (!activeChunk) {
      activeChunk = {
        id: segment.id,
        startMs: timing.startMs,
        endMs: timing.endMs,
        text,
        isResolved: segment.isFinal && endsWithSentencePunctuation(text),
      };
      activeChunkSegmentCount = 1;
    } else {
      activeChunk.text = mergeTranscriptText(activeChunk.text, text);
      activeChunk.endMs = Math.max(activeChunk.endMs, timing.endMs);
      activeChunk.isResolved =
        activeChunk.isResolved || (segment.isFinal && endsWithSentencePunctuation(activeChunk.text));
      activeChunkSegmentCount += 1;
    }

    const hasSentenceBoundary = endsWithSentencePunctuation(activeChunk.text);
    const shouldForceBoundary =
      activeChunkSegmentCount >= MAX_SEGMENTS_PER_TRANSCRIPT_CHUNK ||
      activeChunk.text.length >= MAX_TRANSCRIPT_CHUNK_CHARS;

    if (hasSentenceBoundary || shouldForceBoundary) {
      activeChunk.isResolved = hasSentenceBoundary && activeChunk.isResolved && segment.isFinal;
      chunks.push(activeChunk);
      activeChunk = null;
      activeChunkSegmentCount = 0;
    }
  }

  if (activeChunk) {
    activeChunk.isResolved = false;
    chunks.push(activeChunk);
  }

  return chunks;
}

export function joinTranscriptSentenceChunks(
  chunks: Pick<TranscriptSentenceChunk, "text">[],
) {
  return chunks
    .map((chunk) => chunk.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

export function buildTranscriptSearchMatches(
  chunks: Pick<TranscriptSentenceChunk, "text">[],
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const matches: TranscriptSearchMatch[] = [];
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

export function getActiveTranscriptChunkIndex(
  chunks: Pick<TranscriptSentenceChunk, "startMs" | "endMs">[],
  activeTimeMs: number | null,
) {
  if (activeTimeMs === null || chunks.length === 0) {
    return null;
  }

  let low = 0;
  let high = chunks.length - 1;
  let candidateIndex = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (chunks[middle].startMs <= activeTimeMs) {
      candidateIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (candidateIndex === -1) {
    return null;
  }

  const candidate = chunks[candidateIndex];
  return activeTimeMs >= candidate.startMs && activeTimeMs <= candidate.endMs
    ? candidateIndex
    : null;
}
