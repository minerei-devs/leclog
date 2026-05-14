import { convertFileSrc } from "@tauri-apps/api/core";
import { FileAudio, FileVideo, Pause, Play, SkipBack } from "lucide-react";
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

interface ReviewMediaSource {
  kind: "audio" | "video";
  path: string;
  label: string;
  detail: string;
}

function basename(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function hasVideoExtension(path: string) {
  return /\.(avi|m4v|mkv|mov|mp4|webm)$/i.test(path);
}

function isVideoSource(session: LectureSession, path: string) {
  if (session.audioMimeType) {
    return session.audioMimeType.startsWith("video/");
  }

  return hasVideoExtension(path);
}

function resolveOriginalMediaSource(session: LectureSession): ReviewMediaSource | null {
  const [firstMediaPath] = session.audioFilePaths;
  if (!firstMediaPath || !isVideoSource(session, firstMediaPath)) {
    return null;
  }

  return {
    kind: "video",
    path: firstMediaPath,
    label: "Original video",
    detail: basename(firstMediaPath),
  };
}

function resolveReviewMediaSource(session: LectureSession): ReviewMediaSource | null {
  const originalMediaSource = resolveOriginalMediaSource(session);
  if (originalMediaSource) {
    return originalMediaSource;
  }

  if (session.normalizedAudioPath) {
    return {
      kind: "audio",
      path: session.normalizedAudioPath,
      label: "Normalized audio",
      detail: basename(session.normalizedAudioPath),
    };
  }

  if (session.livePreviewAudioPath) {
    return {
      kind: "audio",
      path: session.livePreviewAudioPath,
      label: "Live preview audio",
      detail: basename(session.livePreviewAudioPath),
    };
  }

  const [firstAudioPath] = session.audioFilePaths;
  if (firstAudioPath) {
    return {
      kind: "audio",
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
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaSource = useMemo(() => resolveReviewMediaSource(session), [session]);
  const mediaUrl = useMemo(
    () => (mediaSource ? toAssetUrl(mediaSource.path) : null),
    [mediaSource],
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
  }, [mediaSource?.path, onTimeChange]);

  useEffect(() => {
    if (!seekRequest || !mediaRef.current) {
      return;
    }

    const nextTimeMs = Math.max(0, Math.min(seekRequest.timeMs, safeDurationMs));
    mediaRef.current.currentTime = nextTimeMs / 1000;
    onTimeChange(nextTimeMs);
  }, [onTimeChange, safeDurationMs, seekRequest]);

  if (!mediaSource) {
    return null;
  }

  function handleLoadedMetadata() {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration)) {
      return;
    }
    setDurationMs(Math.round(media.duration * 1000));
  }

  function handleTimeUpdate() {
    const media = mediaRef.current;
    if (!media) {
      return;
    }
    onTimeChange(Math.round(media.currentTime * 1000));
  }

  function handleSeek(nextTimeMs: number) {
    const nextValue = Math.max(0, Math.min(nextTimeMs, safeDurationMs));
    if (mediaRef.current) {
      mediaRef.current.currentTime = nextValue / 1000;
    }
    onTimeChange(nextValue);
  }

  async function handleTogglePlayback() {
    const media = mediaRef.current;
    if (!media || !mediaUrl) {
      setError("Media preview is only available inside the desktop app.");
      return;
    }

    setError(null);
    if (isPlaying) {
      media.pause();
      return;
    }

    try {
      await media.play();
    } catch {
      setError("Failed to start playback for this managed session file.");
    }
  }

  const playTitle = isPlaying
    ? `Pause ${mediaSource.kind}`
    : `Play ${mediaSource.kind}`;
  const restartTitle = `Restart ${mediaSource.kind}`;

  return (
    <section className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
      {mediaUrl && mediaSource.kind === "video" ? (
        <video
          key={mediaSource.path}
          ref={(node) => {
            mediaRef.current = node;
          }}
          src={mediaUrl}
          className="mb-2 max-h-64 w-full rounded-md bg-black object-contain"
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            setIsPlaying(false);
            setError("This managed video file could not be loaded for playback.");
          }}
        />
      ) : mediaUrl ? (
        <audio
          key={mediaSource.path}
          ref={(node) => {
            mediaRef.current = node;
          }}
          src={mediaUrl}
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleTimeUpdate}
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
            title={playTitle}
            onClick={() => void handleTogglePlayback()}
          >
            {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={restartTitle}
            onClick={() => handleSeek(0)}
          >
            <SkipBack className="size-3.5" />
          </Button>
          {mediaSource.kind === "video" ? (
            <FileVideo className="size-4 shrink-0 text-slate-500" />
          ) : (
            <FileAudio className="size-4 shrink-0 text-slate-500" />
          )}
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-slate-800">{mediaSource.label}</p>
            <p className="truncate text-[11px] text-slate-500" title={mediaSource.path}>
              {mediaSource.detail}
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
          title={`Seek ${mediaSource.kind} and transcript`}
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
