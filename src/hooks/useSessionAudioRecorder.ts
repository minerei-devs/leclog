import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendAudioChunk,
  appendLivePreviewChunk,
  beginAudioSegment,
  finishAudioSegment,
  initializeLivePreview,
} from "../lib/tauri";
import type { LectureSession } from "../types/session";

interface UseSessionAudioRecorderOptions {
  session: LectureSession | null;
  onSessionUpdate: (session: LectureSession) => void;
  onError: (message: string) => void;
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
] as const;

function chooseSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return (
    MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    ""
  );
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  return "bin";
}

export function useSessionAudioRecorder({
  session,
  onSessionUpdate,
  onError,
}: UseSessionAudioRecorderOptions) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const livePreviewBytesRef = useRef<number[]>([]);
  const livePreviewFlushTimerRef = useRef<number | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const stopResolverRef = useRef<(() => void) | null>(null);
  const isStartingRef = useRef(false);
  const suppressAutoStartRef = useRef(false);
  const sessionRef = useRef<LectureSession | null>(session);
  const [isCapturingAudio, setIsCapturingAudio] = useState(false);
  const [audioStatusLabel, setAudioStatusLabel] = useState("Microphone idle");
  const [audioLevel, setAudioLevel] = useState(0);

  const releaseStream = useCallback(() => {
    if (livePreviewFlushTimerRef.current !== null) {
      window.clearInterval(livePreviewFlushTimerRef.current);
      livePreviewFlushTimerRef.current = null;
    }
    livePreviewBytesRef.current = [];

    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    monitorGainRef.current?.disconnect();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    monitorGainRef.current = null;

    void audioContextRef.current?.close();
    audioContextRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    recorderRef.current = null;
    setIsCapturingAudio(false);
    setAudioLevel(0);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const startSegment = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (
      !currentSession ||
      currentSession.status !== "recording" ||
      currentSession.captureSource !== "microphone"
    ) {
      return;
    }
    if (recorderRef.current || isStartingRef.current) {
      return;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined" ||
      typeof AudioContext === "undefined"
    ) {
      onError("This environment does not support microphone recording.");
      return;
    }

    isStartingRef.current = true;
    setAudioStatusLabel("Requesting microphone access...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      await audioContext.resume();
      audioContextRef.current = audioContext;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(
        16_384,
        sourceNode.channelCount,
        1,
      );
      const monitorGain = audioContext.createGain();
      monitorGain.gain.value = 0;
      sourceNode.connect(processorNode);
      processorNode.connect(monitorGain);
      monitorGain.connect(audioContext.destination);
      sourceNodeRef.current = sourceNode;
      processorNodeRef.current = processorNode;
      monitorGainRef.current = monitorGain;

      const requestedMimeType = chooseSupportedMimeType();
      const recorder = requestedMimeType
        ? new MediaRecorder(stream, { mimeType: requestedMimeType })
        : new MediaRecorder(stream);
      const resolvedMimeType = recorder.mimeType || requestedMimeType || "audio/webm";
      const extension = extensionForMimeType(resolvedMimeType);

      const previewReadySession = await initializeLivePreview(
        currentSession.id,
        Math.round(audioContext.sampleRate),
        currentSession.livePreviewAudioPath === null,
      );
      sessionRef.current = previewReadySession;
      onSessionUpdate(previewReadySession);

      const updatedSession = await beginAudioSegment(
        currentSession.id,
        resolvedMimeType,
        extension,
      );
      sessionRef.current = updatedSession;
      onSessionUpdate(updatedSession);

      processorNode.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const channelCount = input.numberOfChannels || 1;
        const frameCount = input.length;

        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
          let mixedSample = 0;
          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            mixedSample += input.getChannelData(channelIndex)[frameIndex] ?? 0;
          }

          const monoSample = Math.max(-1, Math.min(1, mixedSample / channelCount));
          if (frameIndex % 128 === 0) {
            setAudioLevel((previous) => previous * 0.55 + Math.abs(monoSample) * 0.45);
          }
          const pcmValue =
            monoSample < 0
              ? Math.round(monoSample * 0x8000)
              : Math.round(monoSample * 0x7fff);
          const normalizedValue = Math.max(-32768, Math.min(32767, pcmValue));
          const unsignedValue =
            normalizedValue < 0 ? normalizedValue + 0x1_0000 : normalizedValue;
          livePreviewBytesRef.current.push(unsignedValue & 0xff);
          livePreviewBytesRef.current.push((unsignedValue >> 8) & 0xff);
        }
      };

      livePreviewFlushTimerRef.current = window.setInterval(() => {
        const previewChunk = livePreviewBytesRef.current.splice(
          0,
          livePreviewBytesRef.current.length,
        );
        if (previewChunk.length === 0) {
          return;
        }

        void appendLivePreviewChunk(updatedSession.id, previewChunk).catch((error) => {
          onError(
            error instanceof Error
              ? error.message
              : "Failed to persist the live preview audio chunk.",
          );
        });
      }, 1_000);

      recorder.ondataavailable = (event) => {
        void (async () => {
          if (event.data.size === 0) {
            return;
          }

          const buffer = await event.data.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          await appendAudioChunk(updatedSession.id, bytes);
        })().catch((error) => {
          onError(
            error instanceof Error
              ? error.message
              : "Failed to persist the recorded audio chunk.",
          );
        });
      };

      recorder.onstop = () => {
        void (async () => {
          try {
            const previewChunk = livePreviewBytesRef.current.splice(
              0,
              livePreviewBytesRef.current.length,
            );
            if (previewChunk.length > 0) {
              const activeSessionForPreview = sessionRef.current ?? updatedSession;
              await appendLivePreviewChunk(activeSessionForPreview.id, previewChunk);
            }

            const activeSession = sessionRef.current;
            if (activeSession) {
              const updated = await finishAudioSegment(activeSession.id);
              sessionRef.current = updated;
              onSessionUpdate(updated);
            }
          } catch (error) {
            onError(
              error instanceof Error
                ? error.message
                : "Failed to finalize the audio segment.",
            );
          } finally {
            releaseStream();
            stopResolverRef.current?.();
            stopResolverRef.current = null;
            stopPromiseRef.current = null;
            setAudioStatusLabel("Microphone idle");
          }
        })();
      };

      recorder.onerror = () => {
        onError("The browser audio recorder failed while capturing microphone input.");
      };

      recorderRef.current = recorder;
      recorder.start(1_000);
      setIsCapturingAudio(true);
      setAudioStatusLabel(`Recording audio (${extension.toUpperCase()})`);
    } catch (error) {
      releaseStream();
      onError(
        error instanceof Error
          ? error.message
          : "Failed to start microphone recording.",
      );
      setAudioStatusLabel("Microphone unavailable");
    } finally {
      isStartingRef.current = false;
    }
  }, [onError, onSessionUpdate, releaseStream]);

  const stopSegment = useCallback(async (suppressAutoStart = true) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      releaseStream();
      return;
    }
    suppressAutoStartRef.current = suppressAutoStart;
    if (stopPromiseRef.current) {
      return stopPromiseRef.current;
    }

    setAudioStatusLabel("Finalizing audio segment...");

    stopPromiseRef.current = new Promise<void>((resolve) => {
      stopResolverRef.current = resolve;
    });
    recorder.stop();
    return stopPromiseRef.current;
  }, [releaseStream]);

  useEffect(() => {
    if (session?.captureSource === "systemAudio") {
      releaseStream();
      setAudioStatusLabel(
        session.status === "recording"
          ? `System audio capture is active${
              session.captureTargetLabel ? ` (${session.captureTargetLabel})` : ""
            }`
          : session.status === "paused"
            ? "System audio capture is paused"
            : session.status === "processing"
              ? "System audio capture has finished"
              : "System audio capture is idle",
      );
      return;
    }

    if (session?.status !== "recording") {
      suppressAutoStartRef.current = false;
    }

    if (
      session?.status === "recording" &&
      !session.activeAudioFilePath &&
      !suppressAutoStartRef.current
    ) {
      void startSegment();
      return;
    }

    if (session?.status !== "recording" && recorderRef.current) {
      void stopSegment();
    }
  }, [
    releaseStream,
    session?.activeAudioFilePath,
    session?.captureSource,
    session?.captureTargetLabel,
    session?.id,
    session?.status,
    startSegment,
    stopSegment,
  ]);

  useEffect(() => {
    return () => {
      void stopSegment();
    };
  }, [stopSegment]);

  return {
    isCapturingAudio,
    audioStatusLabel,
    audioLevel,
    stopSegment,
  };
}
