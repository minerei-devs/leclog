import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, Import, MessageSquareText, Play, Settings2, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNavigate } from "react-router-dom";
import { useRecentState } from "@/hooks/useRecentState";
import { useProcessingSettings } from "@/hooks/useProcessingSettings";
import { getErrorMessage } from "@/lib/errors";
import { getSessionHref } from "@/lib/session";
import { buildDefaultDraftTitle } from "@/lib/store";
import {
  createSession,
  importMediaSession,
  listAvailableTranscriptionModels,
  listSessionSummaries,
  startSessionRecording,
} from "@/lib/tauri";
import {
  getLanguageLabel,
  getLanguageProfileId,
  transcriptionLanguageProfiles,
} from "@/lib/transcriptionLanguageProfiles";
import type { TranscriptionLanguageProfileId } from "@/lib/transcriptionLanguageProfiles";
import type {
  CaptureSource,
  LectureSession,
  ManagedTranscriptionModel,
  ProcessingQualityPreset,
  ProcessingSettings,
  SessionSummary,
} from "@/types/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RuntimeSetupPanel } from "@/components/RuntimeSetupPanel";

function SourceOption({
  value,
  title,
  description,
  selectedValue,
  onSelect,
}: {
  value: CaptureSource;
  title: string;
  description: string;
  selectedValue: CaptureSource;
  onSelect: (value: CaptureSource) => void;
}) {
  const checked = selectedValue === value;

  return (
    <label
      className={[
        "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
        checked
          ? "border-slate-900 bg-slate-950 text-slate-50 shadow-sm"
          : "border-slate-300 bg-slate-50 text-slate-800 hover:border-slate-500 hover:bg-white",
      ].join(" ")}
      aria-label={`${title}: ${description}`}
      title={description}
    >
      <RadioGroupItem
        value={value}
        checked={checked}
        className={
          checked
            ? "border-white bg-white text-slate-950"
            : "border-slate-600 bg-slate-200 text-slate-900"
        }
        onClick={() => onSelect(value)}
      />
      <div className="min-w-0">
        <div className={checked ? "truncate text-sm font-medium text-white" : "truncate text-sm font-medium"}>
          {title}
        </div>
        <p className="sr-only">{description}</p>
      </div>
    </label>
  );
}

function isGeneratedDraftTitle(value: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value.trim());
}

const presetLabels: Record<ProcessingQualityPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  accurate: "Accurate",
  custom: "Custom",
};

function getModelLabel(
  modelId: string | null | undefined,
  models: ManagedTranscriptionModel[],
) {
  if (!modelId) {
    return "Preset model";
  }
  return models.find((model) => model.id === modelId)?.label ?? modelId;
}

function TranscriptionSettingsDialog({
  open,
  settings,
  languageSelection,
  models,
  onSettingsChange,
  onLanguageSelectionChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  settings: ProcessingSettings;
  languageSelection: TranscriptionLanguageProfileId;
  models: ManagedTranscriptionModel[];
  onSettingsChange: (settings: ProcessingSettings) => void;
  onLanguageSelectionChange: (value: TranscriptionLanguageProfileId) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const installedModels = models.filter((model) => model.installed);
  const selectedModel = settings.preferredModelId
    ? models.find((model) => model.id === settings.preferredModelId) ?? null
    : null;
  const modelOptions =
    selectedModel && !installedModels.some((model) => model.id === selectedModel.id)
      ? [selectedModel, ...installedModels]
      : installedModels;

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close transcription settings"
        onClick={onCancel}
      />
      <section className="relative grid w-full max-w-2xl gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-blue-100 bg-blue-50 p-2 text-blue-700">
              <Settings2 className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-slate-950">
                Transcription settings
              </h2>
              <p id={descriptionId} className="mt-1 text-sm leading-5 text-slate-600">
                Choose the model, recognition behavior, and prompt terms for this session.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close transcription settings"
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label className="text-xs font-medium text-slate-600">Quality</Label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(presetLabels) as ProcessingQualityPreset[]).map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant={settings.qualityPreset === preset ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    onSettingsChange({
                      ...settings,
                      qualityPreset: preset,
                    })
                  }
                >
                  {presetLabels[preset]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Model</span>
              <select
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-3 focus:ring-blue-100"
                value={settings.preferredModelId ?? ""}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    preferredModelId: event.target.value || null,
                  })
                }
                autoFocus
              >
                <option value="">Preset default</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <span className="truncate text-xs text-slate-500">
                {installedModels.length > 0
                  ? getModelLabel(settings.preferredModelId, models)
                  : "No local models are installed yet."}
              </span>
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Transcript language</span>
              <select
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-3 focus:ring-blue-100"
                value={languageSelection}
                onChange={(event) =>
                  onLanguageSelectionChange(event.target.value as TranscriptionLanguageProfileId)
                }
              >
                {transcriptionLanguageProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
                <option value="custom">Custom code</option>
              </select>
              <span className="truncate text-xs text-slate-500">
                {languageSelection === "custom"
                  ? "Use a Whisper language code."
                  : transcriptionLanguageProfiles.find((profile) => profile.id === languageSelection)?.description}
              </span>
            </label>
          </div>

          {languageSelection === "custom" ? (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Custom language code</span>
              <Input
                value={settings.language === "auto" ? "" : settings.language}
                placeholder="fr, de, es..."
                className="h-10 rounded-lg border-slate-300 bg-white text-sm"
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    language: event.target.value.trim() || "auto",
                  })
                }
              />
            </label>
          ) : null}

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Prompt terms</span>
            <textarea
              value={settings.promptTerms}
              onChange={(event) =>
                onSettingsChange({
                  ...settings,
                  promptTerms: event.target.value,
                })
              }
              className="min-h-36 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-3 focus:ring-blue-100"
              placeholder="授業 講義 先生 学生 発表&#10;course-specific names, terms, acronyms..."
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onConfirm}>
            Save settings
          </Button>
        </div>
      </section>
    </div>
  );
}

export function SessionListPage() {
  const navigate = useNavigate();
  const { recentState, isLoaded, updateRecentState } = useRecentState();
  const {
    settings: processingSettings,
    isLoaded: processingSettingsLoaded,
  } = useProcessingSettings();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ManagedTranscriptionModel[]>([]);
  const [draftProcessingSettings, setDraftProcessingSettings] = useState(processingSettings);
  const [settingsDialogDraft, setSettingsDialogDraft] = useState(processingSettings);
  const [settingsDialogLanguageSelection, setSettingsDialogLanguageSelection] =
    useState<TranscriptionLanguageProfileId>(
    () => getLanguageProfileId(processingSettings.language),
  );
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCaptureSource, setDraftCaptureSource] =
    useState<CaptureSource>("microphone");
  const [isStarting, setIsStarting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listSessionSummaries().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    void listAvailableTranscriptionModels().then(setModels).catch(() => {});
  }, []);

  useEffect(() => {
    if (processingSettingsLoaded) {
      setDraftProcessingSettings(processingSettings);
      setSettingsDialogDraft(processingSettings);
      setSettingsDialogLanguageSelection(getLanguageProfileId(processingSettings.language));
    }
  }, [processingSettings, processingSettingsLoaded]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    const nextDefaultTitle = buildDefaultDraftTitle();
    const shouldRefreshDefaultTitle =
      recentState.draftTitle.trim().length === 0 ||
      isGeneratedDraftTitle(recentState.draftTitle);

    setDraftTitle(shouldRefreshDefaultTitle ? nextDefaultTitle : recentState.draftTitle);
    setDraftCaptureSource(recentState.draftCaptureSource);

    if (
      shouldRefreshDefaultTitle &&
      recentState.draftTitle !== nextDefaultTitle
    ) {
      void updateRecentState({ draftTitle: nextDefaultTitle });
    }
  }, [
    isLoaded,
    recentState.draftCaptureSource,
    recentState.draftTitle,
    updateRecentState,
  ]);

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
                await importMediaSession(path, undefined, draftProcessingSettings),
              );
            }

            const refreshed = await listSessionSummaries();
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
  }, [draftProcessingSettings, navigate]);

  async function handleStartSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsStarting(true);

    try {
      const created = await createSession(
        draftTitle,
        draftCaptureSource,
        draftProcessingSettings,
      );
      const recording = await startSessionRecording(created.id);
      const nextDefaultTitle = buildDefaultDraftTitle();
      await updateRecentState({
        activeSessionId: recording.id,
        draftTitle: nextDefaultTitle,
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

  function handleSettingsDialogLanguageSelectionChange(value: TranscriptionLanguageProfileId) {
    setSettingsDialogLanguageSelection(value);
    if (value === "custom") {
      setSettingsDialogDraft((current) => ({
        ...current,
        language: getLanguageProfileId(current.language) === "custom" ? current.language : "",
      }));
      return;
    }

    const profile = transcriptionLanguageProfiles.find((item) => item.id === value);
    if (!profile) {
      return;
    }
    setSettingsDialogDraft((current) => ({
      ...current,
      language: profile.language,
      promptTerms: profile.promptTerms,
    }));
  }

  function openTranscriptionSettingsDialog() {
    setSettingsDialogDraft(draftProcessingSettings);
    setSettingsDialogLanguageSelection(getLanguageProfileId(draftProcessingSettings.language));
    setIsSettingsDialogOpen(true);
  }

  function saveTranscriptionSettingsDraft() {
    setDraftProcessingSettings(settingsDialogDraft);
    setSettingsDialogLanguageSelection(getLanguageProfileId(settingsDialogDraft.language));
    setIsSettingsDialogOpen(false);
  }

  const promptSummary = draftProcessingSettings.promptTerms.trim();
  const modelSummary = getModelLabel(draftProcessingSettings.preferredModelId, models);

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Badge variant="outline" className="rounded-lg border-slate-200 px-2 py-0.5 text-[11px]">
            New session
          </Badge>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
            Capture or import
          </h2>
        </div>
      </div>

      <RuntimeSetupPanel />

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.58fr)]">
        <form
          className="flex min-h-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          onSubmit={handleStartSession}
        >
          <div className="grid gap-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="session-title" className="text-xs font-medium text-slate-600">
                Session title
              </Label>
              <Input
                id="session-title"
                value={draftTitle}
                onChange={(event) => {
                  const nextTitle = event.target.value;
                  setDraftTitle(nextTitle);
                  void updateRecentState({ draftTitle: nextTitle });
                }}
                placeholder="2026-04-22 14:30"
                className="h-10 rounded-lg border-slate-300 bg-white text-base"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs font-medium text-slate-600">Source</Label>
            <RadioGroup
              value={draftCaptureSource}
              onValueChange={(value) => {
                const nextValue = value as CaptureSource;
                setDraftCaptureSource(nextValue);
                void updateRecentState({ draftCaptureSource: nextValue });
              }}
              className="grid gap-2 sm:grid-cols-2"
            >
              <SourceOption
                value="microphone"
                title="Microphone"
                description="Record live lecture notes with the local recorder."
                selectedValue={draftCaptureSource}
                onSelect={(value) => {
                  setDraftCaptureSource(value);
                  void updateRecentState({ draftCaptureSource: value });
                }}
              />
              <SourceOption
                value="systemAudio"
                title="System audio"
                description="Capture a browser window, app, or display using the native picker."
                selectedValue={draftCaptureSource}
                onSelect={(value) => {
                  setDraftCaptureSource(value);
                  void updateRecentState({ draftCaptureSource: value });
                }}
              />
            </RadioGroup>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs font-medium text-slate-600">Transcription</Label>
            <button
              type="button"
              className="grid min-w-0 gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-left transition-colors hover:border-slate-400 hover:bg-white"
              onClick={openTranscriptionSettingsDialog}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="rounded-lg border border-blue-100 bg-blue-50 p-2 text-blue-700">
                  <Settings2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-950">
                    Model, settings, and prompt
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {modelSummary} · {presetLabels[draftProcessingSettings.qualityPreset]} · {getLanguageLabel(draftProcessingSettings.language)}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-blue-700">Edit</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 rounded-md bg-white px-2.5 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
                <MessageSquareText className="size-3.5 shrink-0 text-slate-500" />
                <span className="truncate">
                  {promptSummary ? `Prompt: ${promptSummary}` : "No prompt terms for this session."}
                </span>
              </span>
            </button>
          </div>

          <div className="mt-auto flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center">
            <Button
              type="submit"
              size="lg"
              className="h-12 flex-1 justify-center rounded-lg bg-blue-600 px-4 text-base font-semibold text-white shadow-sm shadow-blue-900/15 hover:bg-blue-700 focus-visible:border-blue-500 focus-visible:ring-blue-500/25"
            >
              <Play className="size-5" />
              {isStarting ? "Starting..." : "Start recording"}
            </Button>

            {activeSession ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 justify-center px-4"
                onClick={() => navigate(`/recording/${activeSession.id}`)}
              >
                <ArrowUpRight className="size-4" />
                Reopen active
              </Button>
            ) : null}
          </div>
        </form>

        <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-950">Import media</h3>
              <p
                className="truncate text-xs text-slate-500"
                title="Drop audio or video files to create transcript-only sessions."
              >
                Drag audio/video files here
              </p>
            </div>
            <Import className="size-4 text-slate-500" />
          </div>

          <div
            className={[
              "grid min-h-24 place-items-center rounded-lg border border-dashed px-4 py-4 text-center transition-colors",
              isImportDragActive
                ? "border-slate-900 bg-slate-950 text-white"
                : "border-slate-300 bg-white text-slate-950",
            ].join(" ")}
          >
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {isImporting ? "Importing media..." : "Drop files here"}
              </p>
              <p className={isImportDragActive ? "text-xs text-slate-300" : "text-xs text-slate-500"}>
                Normalize and transcribe in the background.
              </p>
            </div>
          </div>
        </div>
      </div>

      <TranscriptionSettingsDialog
        open={isSettingsDialogOpen}
        settings={settingsDialogDraft}
        languageSelection={settingsDialogLanguageSelection}
        models={models}
        onSettingsChange={setSettingsDialogDraft}
        onLanguageSelectionChange={handleSettingsDialogLanguageSelectionChange}
        onCancel={() => setIsSettingsDialogOpen(false)}
        onConfirm={saveTranscriptionSettingsDraft}
      />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
    </section>
  );
}
