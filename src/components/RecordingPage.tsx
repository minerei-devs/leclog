import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLiveSessionDuration } from "../hooks/useLiveSessionDuration";
import { useLiveTranscript } from "../hooks/useLiveTranscript";
import { useSessionAudioRecorder } from "../hooks/useSessionAudioRecorder";
import { useSessionPolling } from "../hooks/useSessionPolling";
import { useRecentState } from "../hooks/useRecentState";
import { useTranscriptionSettings } from "../hooks/useTranscriptionSettings";
import { getErrorMessage } from "../lib/errors";
import { formatDuration } from "../lib/format";
import { getCaptureSourceLabel } from "../lib/session";
import {
  getSession,
  pauseSessionRecording,
  startSessionRecording,
  resumeSessionRecording,
  saveSession,
  stopSessionRecording,
} from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { AudioLevelMeter } from "./AudioLevelMeter";
import { ControlBar } from "./ControlBar";
import { PanelList } from "./PanelList";
import { SessionArtifacts } from "./SessionArtifacts";
import { StatusBadge } from "./StatusBadge";
import { TranscriptPanel } from "./TranscriptPanel";

export function RecordingPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { updateRecentState } = useRecentState();
  const { settings: transcriptionSettings } = useTranscriptionSettings();
  const [session, setSession] = useState<LectureSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSessionUpdate = useCallback((nextSession: LectureSession) => {
    setSession(nextSession);
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
  }, []);

  const { isCapturingAudio, audioStatusLabel, audioLevel, stopSegment } = useSessionAudioRecorder({
    session,
    onSessionUpdate: handleSessionUpdate,
    onError: handleError,
  });
  const liveDurationMs = useLiveSessionDuration(session);
  useLiveTranscript({
    session,
    settings: transcriptionSettings,
    onSessionUpdate: handleSessionUpdate,
    onError: handleError,
  });
  useSessionPolling({
    sessionId,
    enabled: Boolean(
      session &&
        (session.status === "recording" ||
          session.status === "processing" ||
          session.transcriptPhase === "live" ||
          session.transcriptPhase === "processing"),
    ),
    intervalMs: 1_000,
    onSession: handleSessionUpdate,
    onError: handleError,
  });

  useEffect(() => {
    if (!sessionId) {
      setError("Missing session id.");
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    void getSession(sessionId)
      .then((result) => {
        if (!isMounted) {
          return;
        }

        setSession(result);
      })
      .catch((reason) => {
        if (!isMounted) {
          return;
        }

        setError(getErrorMessage(reason, "Failed to load session."));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!session?.id) {
      return;
    }

    void updateRecentState({
      activeSessionId: session.status === "done" ? null : session.id,
      draftCaptureSource: session.captureSource,
      lastViewedSessionId: session.id,
    });
  }, [session?.captureSource, session?.id, session?.status, updateRecentState]);

  async function handleStart() {
    if (!session) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      const started = await startSessionRecording(session.id);
      setSession(started);
      await updateRecentState({
        activeSessionId: started.id,
        draftCaptureSource: started.captureSource,
        lastViewedSessionId: started.id,
      });
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to start the session."));
    } finally {
      setIsBusy(false);
    }
  }

  async function updateStatus(nextStatus: "recording" | "paused") {
    if (!session) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      if (nextStatus === "paused") {
        await stopSegment();
      }

      const updated =
        session.status === "idle"
          ? await startSessionRecording(session.id)
          : nextStatus === "paused"
            ? await pauseSessionRecording(session.id)
            : await resumeSessionRecording(session.id);
      setSession(updated);
      await updateRecentState({
        activeSessionId: updated.id,
        draftCaptureSource: updated.captureSource,
        lastViewedSessionId: updated.id,
      });
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to update session state."));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStop() {
    if (!session) {
      return;
    }

    setError(null);
    setIsBusy(true);

    try {
      await stopSegment();
      const processing = await stopSessionRecording(session.id);
      setSession(processing);
      await saveSession(session.id, transcriptionSettings);
      await updateRecentState({
        activeSessionId: null,
        draftCaptureSource: processing.captureSource,
        lastViewedSessionId: processing.id,
      });
      navigate(`/session/${processing.id}`);
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to stop the session."));
    } finally {
      setIsBusy(false);
    }
  }

  if (isLoading) {
    return <div className="empty-state">Loading recording session...</div>;
  }

  if (!session) {
    return (
      <div className="panel">
        <p className="error-banner">{error ?? "Session not found."}</p>
        <Link className="ghost-button" to="/">
          Back to sessions
        </Link>
      </div>
    );
  }

  if (session.captureSource === "importedMedia") {
    return (
      <div className="panel">
        <p className="error-banner">Imported media sessions open in the detail view.</p>
        <Link className="ghost-button" to={`/session/${session.id}`}>
          Open session detail
        </Link>
      </div>
    );
  }

  return (
    <div className="page-grid recording-layout">
      <section className="panel">
        <AudioLevelMeter
          level={session.captureSource === "microphone" ? audioLevel : session.audioLevel ?? 0}
          label={
            session.captureSource === "microphone"
              ? "Microphone input level"
              : "System audio level"
          }
        />

        <div className="panel-header">
          <div>
            <p className="eyebrow">Recording</p>
            <h2>{session.title}</h2>
          </div>
          <StatusBadge status={session.status} />
        </div>

        <PanelList
          rows={[
            {
              label: "Duration",
              value: formatDuration(liveDurationMs),
            },
            {
              label: "Transcript",
              value: `${session.segments.length} segment(s)`,
            },
            {
              label: "Source",
              value: getCaptureSourceLabel(session.captureSource),
            },
            {
              label: "Transcript status",
              value: session.transcriptPhase,
            },
            ...(session.captureTargetLabel
              ? [{ label: "Capture target", value: session.captureTargetLabel }]
              : []),
          ]}
        />

        <ControlBar
          status={session.status}
          isBusy={isBusy}
          onStart={handleStart}
          onPause={() => updateStatus("paused")}
          onResume={() => updateStatus("recording")}
          onStop={handleStop}
        />

        <p className="helper-text">
          {session.captureSource === "systemAudio"
            ? "System audio capture uses macOS ScreenCaptureKit. Select your browser window, application, or display when the native picker opens."
            : "Real microphone audio is captured into local session files."}{" "}
          Draft transcript segments refresh during recording, then a final
          transcript is regenerated locally after you stop the session.
        </p>
        <p className="helper-text">
          {audioStatusLabel}
          {isCapturingAudio ? "." : ""}
        </p>
        <p className="helper-text">
          One uninterrupted take produces one capture file. Pausing and resuming
          creates additional files for the same session.
        </p>

        <SessionArtifacts session={session} />

        {session.transcriptError ? (
          <p className="error-banner">{session.transcriptError}</p>
        ) : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <TranscriptPanel
        segments={session.segments}
        emptyMessage="Transcript segments will appear here during recording and finalize after background processing completes."
      />
    </div>
  );
}
