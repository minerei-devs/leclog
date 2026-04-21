import type { CaptureSource, LectureSession, TranscriptSegment } from "../types/session";

interface TranscriptSentenceChunk {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  isResolved: boolean;
}

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

export function buildTranscriptSentenceChunks(
  segments: TranscriptSegment[],
): TranscriptSentenceChunk[] {
  const chunks: TranscriptSentenceChunk[] = [];
  let activeChunk: TranscriptSentenceChunk | null = null;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }

    if (!activeChunk) {
      activeChunk = {
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text,
        isResolved: segment.isFinal && endsWithSentencePunctuation(text),
      };
    } else {
      activeChunk.text = mergeTranscriptText(activeChunk.text, text);
      activeChunk.endMs = segment.endMs;
      activeChunk.isResolved =
        activeChunk.isResolved || (segment.isFinal && endsWithSentencePunctuation(activeChunk.text));
    }

    if (endsWithSentencePunctuation(activeChunk.text)) {
      activeChunk.isResolved = activeChunk.isResolved && segment.isFinal;
      chunks.push(activeChunk);
      activeChunk = null;
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
