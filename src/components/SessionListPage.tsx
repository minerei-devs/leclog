import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listSessions, createSession, setSessionStatus } from "../lib/tauri";
import type { LectureSession } from "../types/session";
import { SessionCard } from "./SessionCard";
import { useRecentState } from "../hooks/useRecentState";

export function SessionListPage() {
  const navigate = useNavigate();
  const { recentState, isLoaded, updateRecentState } = useRecentState();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
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

        setError(
          reason instanceof Error ? reason.message : "Failed to load sessions.",
        );
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
  }, [isLoaded, recentState.draftTitle]);

  const activeSession = useMemo(
    () =>
      recentState.activeSessionId
        ? sessions.find((session) => session.id === recentState.activeSessionId) ?? null
        : null,
    [recentState.activeSessionId, sessions],
  );

  async function handleStartSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsStarting(true);

    try {
      const created = await createSession(draftTitle);
      const recording = await setSessionStatus(created.id, "recording");
      await updateRecentState({
        activeSessionId: recording.id,
        draftTitle,
        lastViewedSessionId: recording.id,
      });
      navigate(`/recording/${recording.id}`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to start a session.",
      );
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
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Distributed Systems Lecture"
            />
          </label>

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
            <p>Stored locally in a JSON file managed by the Rust backend.</p>
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
