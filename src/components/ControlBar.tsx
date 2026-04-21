import { Pause, Play, Square, Undo2 } from "lucide-react";
import type { SessionStatus } from "../types/session";

interface ControlBarProps {
  status: SessionStatus;
  isBusy: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function ControlBar({
  status,
  isBusy,
  onStart,
  onPause,
  onResume,
  onStop,
}: ControlBarProps) {
  return (
    <div className="control-bar">
      {status === "idle" ? (
        <button className="primary-button" onClick={onStart} disabled={isBusy}>
          <Play className="button-icon" size={16} />
          Start
        </button>
      ) : null}

      {status === "recording" ? (
        <button className="secondary-button" onClick={onPause} disabled={isBusy}>
          <Pause className="button-icon" size={16} />
          Pause
        </button>
      ) : null}

      {status === "paused" ? (
        <button className="secondary-button" onClick={onResume} disabled={isBusy}>
          <Undo2 className="button-icon" size={16} />
          Resume
        </button>
      ) : null}

      <button
        className="primary-button danger-button"
        onClick={onStop}
        disabled={
          isBusy || status === "idle" || status === "processing" || status === "done"
        }
      >
        <Square className="button-icon" size={16} />
        Stop
      </button>
    </div>
  );
}
