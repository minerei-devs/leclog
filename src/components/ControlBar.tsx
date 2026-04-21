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
          Start
        </button>
      ) : null}

      {status === "recording" ? (
        <button className="secondary-button" onClick={onPause} disabled={isBusy}>
          Pause
        </button>
      ) : null}

      {status === "paused" ? (
        <button className="secondary-button" onClick={onResume} disabled={isBusy}>
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
        Stop
      </button>
    </div>
  );
}
