import { Link } from "react-router-dom";
import { formatDate, formatDuration } from "../lib/format";
import { getCaptureSourceLabel, getSessionHref } from "../lib/session";
import type { LectureSession } from "../types/session";
import { StatusBadge } from "./StatusBadge";

interface SessionCardProps {
  session: LectureSession;
}

export function SessionCard({ session }: SessionCardProps) {
  const href = getSessionHref(session);

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
          <dd>
            {session.segments.length} · {session.transcriptPhase}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{getCaptureSourceLabel(session.captureSource)}</dd>
        </div>
      </dl>
    </Link>
  );
}
