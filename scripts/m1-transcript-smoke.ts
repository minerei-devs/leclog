import {
  buildTranscriptSearchMatches,
  buildTranscriptSentenceChunks,
  getActiveTranscriptChunkIndex,
  joinTranscriptSentenceChunks,
} from "../src/lib/session";
import type { TranscriptSegment } from "../src/types/session";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildLongTranscriptFixture(segmentCount: number): TranscriptSegment[] {
  return Array.from({ length: segmentCount }, (_, index) => {
    const startMs = index * 5_000;
    const hasMarker = index % 127 === 0;
    return {
      id: `long-${index}`,
      startMs,
      endMs: startMs + 4_500,
      text: hasMarker
        ? `needle marker ${index}.`
        : `lecture concept ${index} continues without punctuation`,
      isFinal: true,
    };
  });
}

const longSegments = buildLongTranscriptFixture(7_200);
const longChunks = buildTranscriptSentenceChunks(longSegments);
const maxChunkCharacters = Math.max(...longChunks.map((chunk) => chunk.text.length));
const markerMatches = buildTranscriptSearchMatches(longChunks, "needle marker");
const expectedMarkerMatches = longSegments.filter((segment) =>
  segment.text.includes("needle marker"),
).length;
const lateMatch = buildTranscriptSearchMatches(longChunks, "concept 7199")[0];
const activeChunkIndex = getActiveTranscriptChunkIndex(longChunks, 4_318 * 5_000 + 1_000);

assert(longChunks.length > 1_000, "Long unpunctuated transcript collapsed into too few chunks.");
assert(longChunks.length < longSegments.length, "Transcript chunking stopped merging adjacent short segments.");
assert(maxChunkCharacters <= 720, "A transcript chunk exceeded the long-reader row size budget.");
assert(
  markerMatches.length === expectedMarkerMatches,
  `Search found ${markerMatches.length} marker matches; expected ${expectedMarkerMatches}.`,
);
assert(lateMatch && lateMatch.chunkIndex > 1_000, "Late search result did not resolve to a far virtual row.");
assert(
  activeChunkIndex !== null && longChunks[activeChunkIndex].text.includes("4318"),
  "Active playback time did not resolve to the expected transcript chunk.",
);

const plainSegments: TranscriptSegment[] = [
  {
    id: "plain-1",
    startMs: 0,
    endMs: 0,
    text: "plain imported transcript line one",
    isFinal: true,
  },
  {
    id: "plain-2",
    startMs: 0,
    endMs: 0,
    text: "plain imported transcript line two",
    isFinal: true,
  },
];
const plainChunks = buildTranscriptSentenceChunks(plainSegments);
const plainText = joinTranscriptSentenceChunks(plainChunks);

assert(plainChunks.length === 1, "Plain transcript fallback should remain readable.");
assert(plainChunks[0].endMs > plainChunks[0].startMs, "Plain transcript fallback did not synthesize readable timing.");
assert(plainText.includes("plain imported transcript line one"), "Plain transcript text was not preserved.");

console.log(
  JSON.stringify(
    {
      longSegments: longSegments.length,
      virtualRows: longChunks.length,
      maxChunkCharacters,
      markerMatches: markerMatches.length,
      lateMatchChunkIndex: lateMatch.chunkIndex,
      activeChunkIndex,
      plainFallbackDurationMs: plainChunks[0].endMs - plainChunks[0].startMs,
    },
    null,
    2,
  ),
);
