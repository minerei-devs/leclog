import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  createSession,
  listSessions,
  startSessionRecording,
} from "../lib/tauri";
import { getErrorMessage } from "../lib/errors";
import type { CaptureSource, LectureSession } from "../types/session";
import { SessionCard } from "./SessionCard";
import { useRecentState } from "../hooks/useRecentState";

export function SessionListPage() {
  const navigate = useNavigate();
  const { recentState, isLoaded, updateRecentState } = useRecentState();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCaptureSource, setDraftCaptureSource] =
    useState<CaptureSource>("microphone");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
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
        : sessions.find((session) => session.status !== "done") ?? null,
    [recentState.activeSessionId, sessions],
  );

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
              {isStarting ? "Starting..." : "Start"}
            </button>

            {activeSession ? (
              <button
                className="ghost-button"
                type="button"
                onClick={() => navigate(`/recording/${activeSession.id}`)}
              >
                Reopen active
              </button>
            ) : null}
          </div>
        </form>

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
            No sessions yet. Start one to generate a mock live transcript.
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
