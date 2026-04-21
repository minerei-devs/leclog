import { FolderSearch } from "lucide-react";
import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { LectureSession } from "../types/session";
import { PanelList } from "./PanelList";

interface SessionArtifactsProps {
  session: LectureSession;
}

export function SessionArtifacts({ session }: SessionArtifactsProps) {
  const [error, setError] = useState<string | null>(null);

  const rows = [
    {
      label: "Session folder",
      value: session.sessionDir,
      revealable: true,
    },
    {
      label: "Active capture file",
      value: session.activeAudioFilePath,
      revealable: true,
    },
    {
      label: "Capture MIME type",
      value: session.audioMimeType,
      revealable: false,
    },
    {
      label: "Capture target",
      value: session.captureTargetLabel,
      revealable: false,
    },
    {
      label: "Normalized audio",
      value: session.normalizedAudioPath,
      revealable: true,
    },
    {
      label: "Live preview audio",
      value: session.livePreviewAudioPath,
      revealable: true,
    },
    {
      label: "Processed transcript",
      value: session.processedTranscriptPath,
      revealable: true,
    },
    {
      label: "Polished transcript",
      value: session.polishedTranscriptPath,
      revealable: true,
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

      <PanelList
        rows={[
          ...rows.map((row) => ({
            label: row.label,
            value: row.value as string,
            action: row.revealable ? (
              <button
                className="icon-button"
                type="button"
                title="Show in Finder"
                aria-label={`Show ${row.label} in Finder`}
                onClick={() => void handleReveal(row.value as string)}
              >
                <FolderSearch size={15} />
              </button>
            ) : undefined,
          })),
          ...session.audioFilePaths.map((path, index) => ({
            label: `Capture file ${index + 1}`,
            value: path,
            action: (
              <button
                className="icon-button"
                type="button"
                title="Show in Finder"
                aria-label={`Show capture file ${index + 1} in Finder`}
                onClick={() => void handleReveal(path)}
              >
                <FolderSearch size={15} />
              </button>
            ),
          })),
        ]}
      />

      {error ? <p className="error-banner">{error}</p> : null}
    </section>
  );
}
