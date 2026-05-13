import { convertFileSrc } from "@tauri-apps/api/core";
import { Pause, Play, SkipBack } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "../lib/format";
import type { LectureSession } from "../types/session";
import { Button } from "./ui/button";

export interface AudioSeekRequest {
  timeMs: number;
  requestedAt: number;
}

interface SessionAudioReviewBarProps {
  session: LectureSession;
  currentTimeMs: number | null;
  seekRequest: AudioSeekRequest | null;
  onTimeChange: (timeMs: number | null) => void;
}

interface ReviewAudioSource {
  path: string;
  label: string;
  detail: string;
}

function basename(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function resolveReviewAudioSource(session: LectureSession): ReviewAudioSource | null {
  if (session.normalizedAudioPath) {
    return {
      path: session.normalizedAudioPath,
      label: "Normalized audio",
      detail: basename(session.normalizedAudioPath),
    };
  }

  if (session.livePreviewAudioPath) {
    return {
      path: session.livePreviewAudioPath,
      label: "Live preview audio",
      detail: basename(session.livePreviewAudioPath),
    };
  }

  const [firstAudioPath] = session.audioFilePaths;
  if (firstAudioPath) {
    return {
      path: firstAudioPath,
      label:
        session.audioFilePaths.length > 1
          ? `Capture segment 1/${session.audioFilePaths.length}`
          : "Captured audio",
      detail: basename(firstAudioPath),
    };
  }

  return null;
}

function toAssetUrl(path: string) {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

export function SessionAudioReviewBar({
  session,
  currentTimeMs,
  seekRequest,
  onTimeChange,
}: SessionAudioReviewBarProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioSource = useMemo(() => resolveReviewAudioSource(session), [session]);
  const audioUrl = useMemo(
    () => (audioSource ? toAssetUrl(audioSource.path) : null),
    [audioSource],
  );
  const resolvedDurationMs = durationMs ?? session.durationMs;
  const safeDurationMs = Math.max(1, resolvedDurationMs);
  const resolvedCurrentTimeMs = Math.min(
    Math.max(0, currentTimeMs ?? 0),
    safeDurationMs,
  );

  useEffect(() => {
    setDurationMs(null);
    setIsPlaying(false);
    setError(null);
    onTimeChange(null);
  }, [audioSource?.path, onTimeChange]);

  useEffect(() => {
    if (!seekRequest || !audioRef.current) {
      return;
    }

    const nextTimeMs = Math.max(0, Math.min(seekRequest.timeMs, safeDurationMs));
    audioRef.current.currentTime = nextTimeMs / 1000;
    onTimeChange(nextTimeMs);
  }, [onTimeChange, safeDurationMs, seekRequest]);

  if (!audioSource) {
    return null;
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) {
      return;
    }
    setDurationMs(Math.round(audio.duration * 1000));
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    onTimeChange(Math.round(audio.currentTime * 1000));
  }

  function handleSeek(nextTimeMs: number) {
    const nextValue = Math.max(0, Math.min(nextTimeMs, safeDurationMs));
    if (audioRef.current) {
      audioRef.current.currentTime = nextValue / 1000;
    }
    onTimeChange(nextValue);
  }

  async function handleTogglePlayback() {
    const audio = audioRef.current;
    if (!audio || !audioUrl) {
      setError("Audio preview is only available inside the desktop app.");
      return;
    }

    setError(null);
    if (isPlaying) {
      audio.pause();
      return;
    }

    try {
      await audio.play();
    } catch {
      setError("Failed to start audio playback for this managed session file.");
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
      {audioUrl ? (
        <audio
          key={audioSource.path}
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            setIsPlaying(false);
            setError("This managed audio file could not be loaded for playback.");
          }}
        />
      ) : null}

      <div className="grid gap-2 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            title={isPlaying ? "Pause audio" : "Play audio"}
            onClick={() => void handleTogglePlayback()}
          >
            {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Restart audio"
            onClick={() => handleSeek(0)}
          >
            <SkipBack className="size-3.5" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-slate-800">{audioSource.label}</p>
            <p className="truncate text-[11px] text-slate-500" title={audioSource.path}>
              {audioSource.detail}
            </p>
          </div>
        </div>

        <input
          type="range"
          min={0}
          max={safeDurationMs}
          step={250}
          value={resolvedCurrentTimeMs}
          className="h-1.5 w-full min-w-0 accent-slate-950"
          title="Seek audio and transcript"
          onChange={(event) => handleSeek(Number(event.target.value))}
        />

        <div className="flex items-center justify-end gap-1 text-[11px] tabular-nums text-slate-500">
          <span>{formatDuration(resolvedCurrentTimeMs)}</span>
          <span>/</span>
          <span>{formatDuration(resolvedDurationMs)}</span>
        </div>
      </div>

      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
