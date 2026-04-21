const MOCK_SEGMENTS = [
  "Good morning everyone, today we are going to review the main argument from last week's lecture.",
  "The first concept to keep in mind is that clear structure matters more than raw volume of information.",
  "When you compare the two models, the tradeoff shows up in how they handle uncertainty over time.",
  "Notice that the definition becomes more practical once we connect it back to a concrete example.",
  "This is the point where students usually ask whether the method still works under tighter constraints.",
  "For the MVP, we only need enough fidelity to validate the note-taking workflow and review loop.",
  "Let's summarize what we know so far before moving to the final example and key takeaways.",
];

function createSegmentId(index: number) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `segment-${Date.now()}-${index}`;
}

export function buildMockSegment(index: number, startMs: number, endMs: number) {
  return {
    id: createSegmentId(index),
    startMs,
    endMs,
    text: MOCK_SEGMENTS[index % MOCK_SEGMENTS.length],
    isFinal: true,
  };
}
