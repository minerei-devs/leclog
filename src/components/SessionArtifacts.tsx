import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { LectureSession } from "../types/session";

interface SessionArtifactsProps {
  session: LectureSession;
}

export function SessionArtifacts({ session }: SessionArtifactsProps) {
  const [error, setError] = useState<string | null>(null);

  const rows = [
    {
      label: "Session folder",
      value: session.sessionDir,
    },
    {
      label: "Active capture file",
      value: session.activeAudioFilePath,
    },
    {
      label: "Capture MIME type",
      value: session.audioMimeType,
    },
    {
      label: "Capture target",
      value: session.captureTargetLabel,
    },
    {
      label: "Normalized audio",
      value: session.normalizedAudioPath,
    },
    {
      label: "Processed transcript",
      value: session.processedTranscriptPath,
    },
  ].filter((row) => row.value);

  if (rows.length === 0) {
    return null;
  }

  async function handleReveal(path: string) {
    try {
      setError(null);
      await revealItemInDir(path);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Failed to reveal the file in Finder.",
      );
    }
  }

  return (
    <section className="panel-subsection">
      <div className="panel-subsection-header">
        <h3>Local artifacts</h3>
        <p>Stored under the app local data directory.</p>
      </div>

      <dl className="artifact-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="artifact-header">
              <span>{row.label}</span>
              <button
                className="inline-button"
                type="button"
                onClick={() => void handleReveal(row.value as string)}
              >
                Show in Finder
              </button>
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}

        {session.audioFilePaths.length > 0 ? (
          <div>
            <dt>Capture files</dt>
            <dd className="artifact-values">
              {session.audioFilePaths.map((path) => (
                <span key={path} className="artifact-path-row">
                  <span>{path}</span>
                  <button
                    className="inline-button"
                    type="button"
                    onClick={() => void handleReveal(path)}
                  >
                    Show in Finder
                  </button>
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>

      {error ? <p className="error-banner">{error}</p> : null}
    </section>
  );
}
