import {
  Download,
  Languages,
  Settings2,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
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

type SettingsSectionId = "workspace" | "transcription" | "models";

const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
}> = [
  {
    id: "workspace",
    label: "Workspace",
    description: "Overview of local setup and defaults.",
  },
  {
    id: "transcription",
    label: "Transcription",
    description: "Language, prompt terms, and default behavior.",
  },
  {
    id: "models",
    label: "Models",
    description: "Download and manage local Whisper models.",
  },
];

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
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("workspace");

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
  const preferredModelLabel = useMemo(
    () =>
      models.find((model) => model.id === transcriptionSettings.preferredModelId)?.label ??
      transcriptionSettings.preferredModelId,
    [models, transcriptionSettings.preferredModelId],
  );
  const recommendedModel = useMemo(
    () => models.find((model) => model.recommended) ?? null,
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
    <div className="settings-layout">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-intro">
          <p className="eyebrow">Settings</p>
          <h2>Workspace preferences</h2>
          <p>Keep capture, transcription, and model management in one place.</p>
        </div>

        <nav className="settings-section-nav" aria-label="Settings sections">
          {settingsSections.map((section) => (
            <button
              key={section.id}
              className={`settings-section-link ${
                activeSection === section.id ? "settings-section-link-active" : ""
              }`}
              type="button"
              onClick={() => setActiveSection(section.id)}
            >
              <span>{section.label}</span>
              <small>{section.description}</small>
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-content">
        {activeSection === "workspace" ? (
          <>
            <section className="panel settings-hero">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Workspace</p>
                  <h2>Local-first defaults</h2>
                  <p>
                    Tune the app for fast lecture capture on your current machine.
                  </p>
                </div>
                <Settings2 size={18} />
              </div>

              <div className="summary-grid compact-summary-grid">
                <div>
                  <dt>Preferred model</dt>
                  <dd>{preferredModelLabel ?? "Auto-detect recommended"}</dd>
                </div>
                <div>
                  <dt>Language</dt>
                  <dd>{transcriptionSettings.preferredLanguage}</dd>
                </div>
                <div>
                  <dt>Installed models</dt>
                  <dd>{installedCount}</dd>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Recommended setup</h2>
                  <p>Use these defaults as a stable baseline across macOS and Windows.</p>
                </div>
              </div>

              <PanelList
                rows={[
                  {
                    label: "Default model",
                    value: recommendedModel?.label ?? "No recommendation available",
                  },
                  {
                    label: "Prompt terms",
                    value: transcriptionSettings.promptTerms.trim()
                      ? "Custom lecture prompt is enabled"
                      : "No custom prompt terms configured",
                  },
                  {
                    label: "Storage mode",
                    value: "Sessions and models stay local to this device",
                  },
                ]}
              />
            </section>
          </>
        ) : null}

        {activeSection === "transcription" ? (
          <>
            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Transcription</p>
                  <h2>Recognition defaults</h2>
                  <p>Set language hints and what the model should expect from lecture audio.</p>
                </div>
                <Languages size={18} />
              </div>

              <PanelList
                rows={[
                  {
                    label: "Preferred model",
                    value: preferredModelLabel ?? "Auto-detect recommended",
                  },
                  {
                    label: "Language",
                    value: transcriptionSettings.preferredLanguage,
                  },
                ]}
              />

              <div className="stack">
                <label className="field">
                  <span>Language</span>
                  <input
                    value={transcriptionSettings.preferredLanguage}
                    onChange={(event) => {
                      void updateSettings({
                        preferredLanguage: event.target.value.trim() || "auto",
                      });
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
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Behavior notes</h2>
                  <p>These settings affect both imported media and live capture transcription.</p>
                </div>
                <Sparkles size={18} />
              </div>

              <PanelList
                rows={[
                  {
                    label: "Imported audio",
                    value: "Normalized locally, then transcribed in the background",
                  },
                  {
                    label: "Live sessions",
                    value: "Refresh draft transcript during capture, finalize after stop",
                  },
                  {
                    label: "Polishing",
                    value: "Generates a cleaned share-ready transcript from saved segments",
                  },
                ]}
              />
            </section>
          </>
        ) : null}

        {activeSection === "models" ? (
          <>
            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Models</p>
                  <h2>Model manager</h2>
                  <p>Download and switch local Whisper models stored in the app data directory.</p>
                </div>
                <Workflow size={18} />
              </div>

              <PanelList
                rows={[
                  {
                    label: "Installed",
                    value: String(installedCount),
                  },
                  {
                    label: "Preferred",
                    value: preferredModelLabel ?? "Auto-detect recommended",
                  },
                  {
                    label: "Recommended",
                    value: recommendedModel?.label ?? "No recommendation available",
                  },
                ]}
              />
            </section>

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
                          {model.downloadStatus === "downloading"
                            ? "Downloading..."
                            : "Download"}
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
          </>
        ) : null}

        {error ? <p className="error-banner">{error}</p> : null}
      </div>
    </div>
  );
}
