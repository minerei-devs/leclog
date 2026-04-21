import {
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  PauseCircle,
  TimerReset,
} from "lucide-react";
import type { SessionStatus } from "../types/session";

interface StatusBadgeProps {
  status: SessionStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const icon =
    status === "idle" ? (
      <TimerReset size={14} />
    ) : status === "recording" ? (
      <CircleDot size={14} />
    ) : status === "paused" ? (
      <PauseCircle size={14} />
    ) : status === "processing" ? (
      <LoaderCircle size={14} />
    ) : (
      <CheckCircle2 size={14} />
    );

  return (
    <span className={`status-badge status-${status}`}>
      {icon}
      {status}
    </span>
  );
}
