import { Link } from "react-router-dom";
import { formatDate, formatDuration } from "../lib/format";
import type { LectureSession } from "../types/session";
import { StatusBadge } from "./StatusBadge";

interface SessionCardProps {
  session: LectureSession;
}

export function SessionCard({ session }: SessionCardProps) {
  return (
    <Link className="session-card" to={`/session/${session.id}`}>
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
          <dt>Segments</dt>
          <dd>{session.segments.length}</dd>
        </div>
      </dl>
    </Link>
  );
}
