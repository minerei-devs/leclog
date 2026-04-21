import { Download, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "../lib/format";
import {
  deleteTranscriptionModel,
  downloadTranscriptionModel,
  listAvailableTranscriptionModels,
} from "../lib/tauri";
import type { ManagedTranscriptionModel } from "../types/session";
import { PanelList } from "./PanelList";
import { useTranscriptionSettings } from "../hooks/useTranscriptionSettings";

function progressLabel(model: ManagedTranscriptionModel) {
  if (model.downloadStatus !== "downloading") {
    return null;
  }

  const total = model.totalBytes ?? model.sizeBytes;
  if (!total) {
    return "Downloading...";
  }

  const percentage = Math.min(100, Math.round((model.downloadedBytes / total) * 100));
  return `${percentage}% · ${formatBytes(model.downloadedBytes)} / ${formatBytes(total)}`;
}

export function SettingsPage() {
  const {
    settings: transcriptionSettings,
    isLoaded: settingsLoaded,
    updateSettings,
  } = useTranscriptionSettings();
  const [models, setModels] = useState<ManagedTranscriptionModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshModels() {
    const nextModels = await listAvailableTranscriptionModels();
    setModels(nextModels);
  }

  useEffect(() => {
    let isMounted = true;

    void refreshModels()
      .catch((reason) => {
        if (isMounted) {
          setError(reason instanceof Error ? reason.message : "Failed to load models.");
        }
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
    if (!models.some((model) => model.downloadStatus === "downloading")) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshModels().catch(() => {});
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [models]);

  const installedCount = useMemo(
    () => models.filter((model) => model.installed).length,
    [models],
  );

  async function handleDownload(modelId: string) {
    setError(null);
    setBusyModelId(modelId);

    try {
      await downloadTranscriptionModel(modelId);
      await refreshModels();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to start model download.");
    } finally {
      setBusyModelId(null);
    }
  }

  async function handleDelete(modelId: string) {
    setError(null);
    setBusyModelId(modelId);

    try {
      await deleteTranscriptionModel(modelId);
      if (transcriptionSettings.preferredModelId === modelId) {
        await updateSettings({ preferredModelId: null });
      }
      await refreshModels();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete model.");
    } finally {
      setBusyModelId(null);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>Transcription</h2>
          </div>
          <Settings2 size={18} />
        </div>

        <PanelList
          rows={[
            {
              label: "Preferred model",
              value: transcriptionSettings.preferredModelId ?? "Auto-detect recommended",
            },
            {
              label: "Language",
              value: transcriptionSettings.preferredLanguage,
            },
            {
              label: "Installed models",
              value: String(installedCount),
            },
          ]}
        />

        <div className="stack">
          <label className="field">
            <span>Language</span>
            <input
              value={transcriptionSettings.preferredLanguage}
              onChange={(event) => {
                void updateSettings({ preferredLanguage: event.target.value.trim() || "auto" });
              }}
              disabled={!settingsLoaded}
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
              disabled={!settingsLoaded}
              placeholder="これは大学の講義の書き起こしです。自然な日本語の句読点..."
            />
          </label>
        </div>

        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Model manager</h2>
            <p>Download and switch local Whisper models stored in the app data directory.</p>
          </div>
        </div>

        {isLoading ? <div className="empty-state">Loading models...</div> : null}

        {!isLoading ? (
          <div className="session-list">
            {models.map((model) => {
              const isPreferred = transcriptionSettings.preferredModelId === model.id;
              const canDelete = model.installed && model.managedByApp;
              const progress = progressLabel(model);

              return (
                <section key={model.id} className="session-card model-card">
                  <div className="session-card-header">
                    <div>
                      <h3>
                        {model.label}
                        {model.recommended ? " · Recommended" : ""}
                      </h3>
                      <p>{model.id}</p>
                    </div>
                    <span
                      className={`status-badge ${
                        model.installed ? "status-done" : "status-idle"
                      }`}
                    >
                      {model.installed ? "installed" : model.downloadStatus}
                    </span>
                  </div>

                  <PanelList
                    rows={[
                      {
                        label: "Size",
                        value: formatBytes(model.sizeBytes),
                      },
                      {
                        label: "Status",
                        value: progress ?? model.downloadStatus,
                      },
                      ...(model.installedPath
                        ? [{ label: "Path", value: model.installedPath }]
                        : []),
                      {
                        label: "Source",
                        value: model.managedByApp ? "App-managed" : "Bundled / external",
                      },
                    ]}
                  />

                  <div className="button-row">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!model.installed || isPreferred}
                      onClick={() => void updateSettings({ preferredModelId: model.id })}
                    >
                      {isPreferred ? "Selected" : "Use this model"}
                    </button>

                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        model.installed ||
                        model.downloadStatus === "downloading" ||
                        busyModelId === model.id
                      }
                      onClick={() => void handleDownload(model.id)}
                    >
                      <Download className="button-icon" size={16} />
                      {model.downloadStatus === "downloading" ? "Downloading..." : "Download"}
                    </button>

                    {canDelete ? (
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={busyModelId === model.id}
                        onClick={() => void handleDelete(model.id)}
                      >
                        <Trash2 className="button-icon" size={16} />
                        Remove
                      </button>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
