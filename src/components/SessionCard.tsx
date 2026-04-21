import { Link } from "react-router-dom";
import { formatDate, formatDuration } from "../lib/format";
import type { LectureSession } from "../types/session";
import { StatusBadge } from "./StatusBadge";

interface SessionCardProps {
  session: LectureSession;
}

export function SessionCard({ session }: SessionCardProps) {
  const href =
    session.status === "done" ? `/session/${session.id}` : `/recording/${session.id}`;

  return (
    <Link className="session-card" to={href}>
      <div className="session-card-header">
        <div>
          <h3>{session.title}</h3>
          <p>{formatDate(session.updatedAt)}</p>
        </div>
        <StatusBadge status={session.status} />
      </div>

      <dl className="session-card-meta">
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(session.durationMs)}</dd>
        </div>
        <div>
          <dt>Transcript</dt>
          <dd>{session.segments.length}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{session.captureSource === "systemAudio" ? "System audio" : "Microphone"}</dd>
        </div>
      </dl>
    </Link>
  );
}
