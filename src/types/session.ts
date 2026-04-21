export type SessionStatus =
  | "idle"
  | "recording"
  | "paused"
  | "processing"
  | "done";

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

export interface LectureSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  durationMs: number;
  segments: TranscriptSegment[];
}

export interface RecentState {
  activeSessionId: string | null;
  draftTitle: string;
  lastViewedSessionId: string | null;
}
