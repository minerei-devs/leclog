import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNavigate } from "react-router-dom";
import {
  createSession,
  importMediaSession,
  listTranscriptionModels,
  listSessions,
  startSessionRecording,
} from "../lib/tauri";
import { getErrorMessage } from "../lib/errors";
import { getSessionHref } from "../lib/session";
import type { CaptureSource, LectureSession, TranscriptionModelInfo } from "../types/session";
import { SessionCard } from "./SessionCard";
import { useRecentState } from "../hooks/useRecentState";
import { useSessionPolling } from "../hooks/useSessionPolling";
import { useTranscriptionSettings } from "../hooks/useTranscriptionSettings";

export function SessionListPage() {
  const navigate = useNavigate();
  const { recentState, isLoaded, updateRecentState } = useRecentState();
  const {
    settings: transcriptionSettings,
    isLoaded: transcriptionSettingsLoaded,
    updateSettings,
  } = useTranscriptionSettings();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [models, setModels] = useState<TranscriptionModelInfo[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCaptureSource, setDraftCaptureSource] =
    useState<CaptureSource>("microphone");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void listSessions()
      .then((result) => {
        if (!isMounted) {
          return;
        }

        setSessions(result);
      })
      .catch((reason) => {
        if (!isMounted) {
          return;
        }

        setError(getErrorMessage(reason, "Failed to load sessions."));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    void listTranscriptionModels()
      .then((result) => {
        if (isMounted) {
          setModels(result);
        }
      })
      .catch(() => {
        if (isMounted) {
          setModels([]);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    setDraftTitle(recentState.draftTitle);
    setDraftCaptureSource(recentState.draftCaptureSource);
  }, [isLoaded, recentState.draftCaptureSource, recentState.draftTitle]);

  const activeSession = useMemo(
    () =>
      recentState.activeSessionId
        ? sessions.find((session) => session.id === recentState.activeSessionId) ?? null
        : sessions.find(
            (session) =>
              session.captureSource !== "importedMedia" && session.status !== "done",
          ) ?? null,
    [recentState.activeSessionId, sessions],
  );
  const hasActiveProcessing = sessions.some(
    (session) =>
      session.status !== "done" ||
      session.transcriptPhase === "processing" ||
      session.transcriptPhase === "live",
  );

  useSessionPolling({
    enabled: hasActiveProcessing,
    intervalMs: 1_500,
    onSessions: setSessions,
    onError: setError,
  });

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | undefined;

    async function attachDragDropListener() {
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (!isMounted) {
          return;
        }

        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsImportDragActive(true);
          return;
        }

        if (event.payload.type === "leave") {
          setIsImportDragActive(false);
          return;
        }

        if (event.payload.type === "drop") {
          setIsImportDragActive(false);
          const paths = event.payload.paths.filter((path) => path.trim().length > 0);
          if (paths.length === 0) {
            return;
          }

          setIsImporting(true);
          setError(null);

          try {
            const importedSessions: LectureSession[] = [];
            for (const path of paths) {
              importedSessions.push(
                await importMediaSession(path, undefined, transcriptionSettings),
              );
            }

            const refreshed = await listSessions();
            if (!isMounted) {
              return;
            }

            setSessions(refreshed);
            if (importedSessions.length === 1) {
              navigate(getSessionHref(importedSessions[0]));
            }
          } catch (reason) {
            if (isMounted) {
              setError(getErrorMessage(reason, "Failed to import media files."));
            }
          } finally {
            if (isMounted) {
              setIsImporting(false);
            }
          }
        }
      });
    }

    void attachDragDropListener();

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [navigate, transcriptionSettings]);

  async function handleStartSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsStarting(true);

    try {
      const created = await createSession(draftTitle, draftCaptureSource);
      const recording = await startSessionRecording(created.id);
      await updateRecentState({
        activeSessionId: recording.id,
        draftTitle,
        draftCaptureSource,
        lastViewedSessionId: recording.id,
      });
      navigate(`/recording/${recording.id}`);
    } catch (reason) {
      setError(getErrorMessage(reason, "Failed to start a session."));
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Lecture Session MVP</p>
            <h2>Start a new recording</h2>
          </div>
        </div>

        <form className="stack" onSubmit={handleStartSession}>
          <label className="field">
            <span>Session title</span>
            <input
              value={draftTitle}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setDraftTitle(nextTitle);
                void updateRecentState({ draftTitle: nextTitle });
              }}
              placeholder="Distributed Systems Lecture"
            />
          </label>

          <fieldset className="source-selector">
            <legend>Recording source</legend>

            <label className="source-option">
              <input
                type="radio"
                name="capture-source"
                value="microphone"
                checked={draftCaptureSource === "microphone"}
                onChange={() => {
                  setDraftCaptureSource("microphone");
                  void updateRecentState({ draftCaptureSource: "microphone" });
                }}
              />
              <span>
                <strong>Microphone</strong>
                <small>Uses the browser recorder and writes audio-only local files.</small>
              </span>
            </label>

            <label className="source-option">
              <input
                type="radio"
                name="capture-source"
                value="systemAudio"
                checked={draftCaptureSource === "systemAudio"}
                onChange={() => {
                  setDraftCaptureSource("systemAudio");
                  void updateRecentState({ draftCaptureSource: "systemAudio" });
                }}
              />
              <span>
                <strong>System audio</strong>
                <small>
                  macOS opens a native picker so you can choose a browser window,
                  application, or display.
                </small>
              </span>
            </label>
          </fieldset>

          <div className="button-row">
            <button className="primary-button" type="submit" disabled={isStarting}>
              <Play className="button-icon" size={16} />
              {isStarting ? "Starting..." : "Start"}
            </button>

            {activeSession ? (
              <button
                className="ghost-button"
                type="button"
                onClick={() => navigate(`/recording/${activeSession.id}`)}
              >
                <ArrowUpRight className="button-icon" size={16} />
                Reopen active
              </button>
            ) : null}
          </div>
        </form>

        <section className="panel-subsection">
          <div className="panel-subsection-header">
            <h3>Import media</h3>
            <p>Drag audio or video files into this window to create transcript-only sessions.</p>
          </div>

          <div className={`dropzone ${isImportDragActive ? "dropzone-active" : ""}`}>
            <strong>{isImporting ? "Importing media..." : "Drop audio or video files here"}</strong>
            <p>
              Imported files are copied into the app data directory, normalized with ffmpeg, then
              transcribed in the background.
            </p>
          </div>
        </section>

        <section className="panel-subsection">
          <div className="panel-subsection-header">
            <h3>Transcription defaults</h3>
            <p>Lightweight settings stored locally. Processing runs in the background.</p>
          </div>

          <label className="field">
            <span>Preferred model</span>
            <select
              value={transcriptionSettings.preferredModelId ?? ""}
              onChange={(event) => {
                const nextModelId = event.target.value || null;
                void updateSettings({ preferredModelId: nextModelId });
              }}
              disabled={!transcriptionSettingsLoaded}
            >
              <option value="">Auto-detect recommended</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                  {model.recommended ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Language</span>
            <input
              value={transcriptionSettings.preferredLanguage}
              onChange={(event) => {
                void updateSettings({ preferredLanguage: event.target.value.trim() || "auto" });
              }}
              placeholder="ja"
            />
          </label>

          <label className="field">
            <span>Prompt terms</span>
            <input
              value={transcriptionSettings.promptTerms}
              onChange={(event) => {
                void updateSettings({ promptTerms: event.target.value });
              }}
              placeholder="授業 講義 先生 学生 発表"
            />
          </label>

          <p className="helper-text">
            Installed models: {models.length === 0 ? "none found yet" : models.length}
          </p>
        </section>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Saved sessions</h2>
            <p>Each session keeps its own local folder and source capture files.</p>
          </div>
        </div>

        {isLoading ? <div className="empty-state">Loading sessions...</div> : null}

        {!isLoading && sessions.length === 0 ? (
          <div className="empty-state">
            No sessions yet. Start one to begin local recording and background transcription.
          </div>
        ) : null}

        {sessions.length > 0 ? (
          <div className="session-list">
            {sessions.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
