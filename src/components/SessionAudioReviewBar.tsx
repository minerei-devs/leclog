import { convertFileSrc } from "@tauri-apps/api/core";
import {
  FastForward,
  FileAudio,
  FileVideo,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  Wrench,
} from "lucide-react";
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
  isReprocessing?: boolean;
  onOpenResources?: () => void;
  onReprocess?: () => void | Promise<void>;
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

const playbackRates = [0.75, 1, 1.25, 1.5, 2] as const;

export function SessionAudioReviewBar({
  session,
  currentTimeMs,
  seekRequest,
  onTimeChange,
  isReprocessing = false,
  onOpenResources,
  onReprocess,
}: SessionAudioReviewBarProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
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

  useEffect(() => {
    if (!mediaRef.current) {
      return;
    }

    mediaRef.current.playbackRate = playbackRate;
  }, [mediaUrl, playbackRate]);

  if (!mediaSource) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-950">Review audio is unavailable</p>
            <p className="text-[11px] text-amber-800">
              This session has no managed audio or video file attached.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onOpenResources ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenResources}>
                Resources
              </Button>
            ) : null}
            {onReprocess ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isReprocessing || session.audioFilePaths.length === 0}
                title={
                  session.audioFilePaths.length === 0
                    ? "This session has no capture files to reprocess."
                    : "Run normalize, transcribe, merge, and polish again for this session."
                }
                onClick={() => void onReprocess()}
              >
                <Wrench className="size-3.5" />
                Repair
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    );
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

  function handleSkip(deltaMs: number) {
    handleSeek(resolvedCurrentTimeMs + deltaMs);
  }

  function handlePlaybackRateChange(nextRate: number) {
    setPlaybackRate(nextRate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = nextRate;
    }
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Skip ${mediaSource.kind} back 10 seconds`}
            onClick={() => handleSkip(-10_000)}
          >
            <RotateCcw className="size-3.5" />
            10s
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Skip ${mediaSource.kind} forward 30 seconds`}
            onClick={() => handleSkip(30_000)}
          >
            <FastForward className="size-3.5" />
            30s
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

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div
          className="inline-flex min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-0.5"
          aria-label="Playback speed"
        >
          {playbackRates.map((rate) => {
            const selected = playbackRate === rate;
            return (
              <button
                key={rate}
                type="button"
                className={[
                  "h-6 rounded-md px-2 text-[11px] font-semibold transition-colors",
                  selected
                    ? "bg-slate-950 text-white shadow-sm"
                    : "text-slate-600 hover:bg-white hover:text-slate-950",
                ].join(" ")}
                aria-pressed={selected}
                title={`Set playback speed to ${rate}x`}
                onClick={() => handlePlaybackRateChange(rate)}
              >
                {rate}x
              </button>
            );
          })}
        </div>
        {onOpenResources || onReprocess ? (
          <div className="flex shrink-0 items-center gap-1">
            {onOpenResources ? (
              <Button type="button" variant="ghost" size="sm" onClick={onOpenResources}>
                Resources
              </Button>
            ) : null}
            {onReprocess ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isReprocessing || session.audioFilePaths.length === 0}
                title={
                  session.audioFilePaths.length === 0
                    ? "This session has no capture files to reprocess."
                    : "Run normalize, transcribe, merge, and polish again for this session."
                }
                onClick={() => void onReprocess()}
              >
                <Wrench className="size-3.5" />
                Repair
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
