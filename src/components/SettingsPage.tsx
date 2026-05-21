import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  FolderSearch,
  Gauge,
  HardDrive,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getErrorMessage } from "@/lib/errors";
import { formatBytes, formatDate } from "@/lib/format";
import {
  getLanguageLabel,
  getLanguageProfileId,
  isEnglishOnlyModel,
  languageNeedsMultilingualModel,
  resolveLikelyTranscriptionModelId,
  transcriptionLanguageProfiles,
} from "@/lib/transcriptionLanguageProfiles";
import {
  cancelBackgroundTask,
  deleteResource,
  deleteSession,
  deleteTranscriptionModel,
  downloadTranscriptionModel,
  getRuntimeStatus,
  listAvailableTranscriptionModels,
  listBackgroundTasks,
  listResources,
  listTranscriptionModels,
  revealResource,
  retrySessionProcessing,
} from "@/lib/tauri";
import {
  canRetryTask,
  isActiveTask,
  retryTaskLabel,
  summarizeTaskError,
  taskFailureMeta,
} from "@/lib/tasks";
import type {
  BackgroundTask,
  ManagedTranscriptionModel,
  ProcessingQualityPreset,
  ResourceItem,
  ResourceKind,
  ResourceOverview,
  RuntimeStatus,
  TranscriptionModelInfo,
} from "@/types/session";
import type { TranscriptionLanguageProfileId } from "@/lib/transcriptionLanguageProfiles";
import { useAppSettings } from "@/hooks/useAppSettings";
import { useProcessingSettings } from "@/hooks/useProcessingSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export type SettingsPanelId = "overview" | "transcription" | "models" | "storage" | "tasks" | "gaps";

type PendingSettingsDelete =
  | { kind: "resource"; resource: ResourceItem }
  | { kind: "model"; modelId: string }
  | null;

interface SettingsPageProps {
  isOpen: boolean;
  initialPanel?: SettingsPanelId;
  onClose: () => void;
}

const panels: Array<{
  id: SettingsPanelId;
  label: string;
  description: string;
}> = [
  { id: "overview", label: "Overview", description: "Runtime health and defaults" },
  { id: "transcription", label: "Transcription", description: "Quality, chunks, threads" },
  { id: "models", label: "Models", description: "Whisper model files" },
  { id: "storage", label: "Storage", description: "App-owned resources" },
  { id: "tasks", label: "Tasks", description: "Background queue" },
  { id: "gaps", label: "Product gaps", description: "Still unfinished" },
];

const presetLabels: Record<ProcessingQualityPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  accurate: "Accurate",
  custom: "Custom",
};

const resourceKindLabels: Record<ResourceKind, string> = {
  appData: "App data",
  sessionDir: "Session",
  audio: "Audio",
  normalizedAudio: "Normalized",
  livePreviewAudio: "Preview",
  transcript: "Transcript",
  model: "Model",
  partialDownload: "Partial",
};

const productGaps = [
  {
    title: "Transcript editor",
    detail: "Currently transcripts can be copied and polished, but not edited, merged, searched, or corrected in place.",
  },
  {
    title: "Task persistence",
    detail: "Tasks are visible for the current app run; deeper history and per-task logs still need persistent storage.",
  },
  {
    title: "Import controls",
    detail: "Drag-and-drop works, but there is no guided import dialog, file validation preview, or batch naming flow.",
  },
  {
    title: "Export surface",
    detail: "TXT artifacts exist; Markdown, SRT/VTT, PDF, and direct share/export presets are missing.",
  },
  {
    title: "Resource cleanup policy",
    detail: "Users can delete resources manually, but automatic retention rules and stale-cache cleanup are not defined.",
  },
  {
    title: "Error recovery",
    detail: "Reprocess is available, but failed tasks need clearer causes, logs, and one-click dependency fixes.",
  },
];

interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

type UpdateStatus = "idle" | "checking" | "available" | "none" | "installing" | "installed" | "error";

function taskStatusClass(status: BackgroundTask["status"]) {
  if (status === "running" || status === "queued") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "failed") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
      <p className="truncate text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{value}</p>
      {detail ? <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

function SectionHeader({
  title,
  detail,
  icon,
}: {
  title: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-slate-950">{title}</h3>
        <p className="mt-0.5 text-sm text-slate-500">{detail}</p>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-500">
        {icon}
      </div>
    </div>
  );
}

function ResourceLine({
  resource,
  onCopy,
  onReveal,
  onClear,
}: {
  resource: ResourceItem;
  onCopy: (path: string) => void;
  onReveal: (path: string) => void;
  onClear: (resource: ResourceItem) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-100 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="rounded-md border-slate-200 bg-slate-50 px-1.5 text-[10px] text-slate-600">
            {resourceKindLabels[resource.kind]}
          </Badge>
          <p className="truncate text-sm font-medium text-slate-950">{resource.label}</p>
          <span className="shrink-0 text-xs text-slate-500">{formatBytes(resource.sizeBytes)}</span>
        </div>
        <p className="mt-1 truncate text-xs text-slate-500">{resource.path}</p>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" title="Copy path" onClick={() => onCopy(resource.path)}>
          <Copy className="size-3.5" />
        </Button>
        {resource.revealable ? (
          <Button type="button" variant="ghost" size="icon-sm" title="Reveal" onClick={() => onReveal(resource.path)}>
            <FolderSearch className="size-3.5" />
          </Button>
        ) : null}
        {resource.deletable ? (
          <Button type="button" variant="destructive" size="icon-sm" title="Clear" onClick={() => onClear(resource)}>
            <Eraser className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPage({ isOpen, initialPanel, onClose }: SettingsPageProps) {
  const {
    settings: appSettings,
    isLoaded: appSettingsLoaded,
    updateSettings: updateAppSettings,
  } = useAppSettings();
  const {
    settings: processingSettings,
    isLoaded: settingsLoaded,
    updateSettings,
  } = useProcessingSettings();
  const [activePanel, setActivePanel] = useState<SettingsPanelId>("overview");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [resourceOverview, setResourceOverview] = useState<ResourceOverview | null>(null);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [models, setModels] = useState<ManagedTranscriptionModel[]>([]);
  const [installedModels, setInstalledModels] = useState<TranscriptionModelInfo[]>([]);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({
    downloadedBytes: 0,
    totalBytes: null,
  });
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingSettingsDelete>(null);
  const [languageSelection, setLanguageSelection] = useState<TranscriptionLanguageProfileId>(
    () => getLanguageProfileId(processingSettings.language),
  );
  const [customLanguageDraft, setCustomLanguageDraft] = useState("");
  const wasOpenRef = useRef(false);
  const pendingInitialPanelRef = useRef<SettingsPanelId | null>(null);
  const lastInitialPanelRef = useRef<SettingsPanelId | undefined>(undefined);

  const refreshOverview = useCallback(async () => {
    const [nextRuntimeStatus, nextTasks, nextAppVersion] = await Promise.all([
      getRuntimeStatus(),
      listBackgroundTasks(),
      getVersion(),
    ]);
    setRuntimeStatus(nextRuntimeStatus);
    setTasks(nextTasks);
    setAppVersion(nextAppVersion);
    setError(null);
  }, []);

  const refreshOverviewLight = useCallback(async () => {
    const [nextTasks, nextAppVersion] = await Promise.all([
      listBackgroundTasks(),
      getVersion(),
    ]);
    setTasks(nextTasks);
    setAppVersion(nextAppVersion);
    setError(null);
  }, []);

  const refreshStorage = useCallback(async () => {
    const nextResourceOverview = await listResources();
    setResourceOverview(nextResourceOverview);
    setError(null);
  }, []);

  const refreshTasks = useCallback(async () => {
    const nextTasks = await listBackgroundTasks();
    setTasks(nextTasks);
    setError(null);
  }, []);

  const refreshModels = useCallback(async () => {
    const [nextModels, nextInstalledModels] = await Promise.all([
      listAvailableTranscriptionModels(),
      listTranscriptionModels(),
    ]);
    setModels(nextModels);
    setInstalledModels(nextInstalledModels);
    setError(null);
  }, []);

  const refreshPanel = useCallback(
    async (panel: SettingsPanelId) => {
      if (panel === "overview") {
        if (runtimeStatus) {
          await refreshOverviewLight();
        } else {
          await refreshOverview();
        }
        return;
      }
      if (panel === "storage") {
        await refreshStorage();
        return;
      }
      if (panel === "models" || panel === "transcription") {
        await refreshModels();
        return;
      }
      if (panel === "tasks") {
        await refreshTasks();
        return;
      }
      setError(null);
    },
    [refreshModels, refreshOverview, refreshOverviewLight, refreshStorage, refreshTasks, runtimeStatus],
  );

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      pendingInitialPanelRef.current = null;
      lastInitialPanelRef.current = undefined;
      return;
    }
    const shouldApplyInitialPanel =
      !wasOpenRef.current || initialPanel !== lastInitialPanelRef.current;
    if (shouldApplyInitialPanel) {
      const nextPanel = initialPanel ?? "overview";
      pendingInitialPanelRef.current = nextPanel;
      setActivePanel(nextPanel);
    }
    wasOpenRef.current = true;
    lastInitialPanelRef.current = initialPanel;
  }, [initialPanel, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (
      pendingInitialPanelRef.current !== null &&
      activePanel !== pendingInitialPanelRef.current
    ) {
      return;
    }
    pendingInitialPanelRef.current = null;

    void refreshPanel(activePanel).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Failed to load settings.");
    });
  }, [activePanel, isOpen, refreshPanel]);

  useEffect(() => {
    if (!isOpen || !tasks.some(isActiveTask)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshTasks().catch(() => {});
      if (activePanel === "models") {
        void refreshModels().catch(() => {});
      }
    }, 1500);
    return () => window.clearInterval(intervalId);
  }, [activePanel, isOpen, refreshModels, refreshTasks, tasks]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (pendingDelete) {
        return;
      }
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, pendingDelete]);

  useEffect(() => {
    const nextSelection = getLanguageProfileId(processingSettings.language);
    setLanguageSelection(nextSelection);
    setCustomLanguageDraft(nextSelection === "custom" ? processingSettings.language : "");
  }, [processingSettings.language]);

  const installedCount = models.filter((model) => model.installed).length;
  const installedModelIds = installedModels.map((model) => model.id);
  const likelyModelId = resolveLikelyTranscriptionModelId(processingSettings, installedModelIds);
  const modelLanguageWarning =
    likelyModelId &&
    isEnglishOnlyModel(likelyModelId) &&
    languageNeedsMultilingualModel(processingSettings.language)
      ? `${likelyModelId} is English-only. ${getLanguageLabel(processingSettings.language)} needs a multilingual model such as Base, Small, or Large v3 Turbo.`
      : null;
  const preferredModelLabel =
    models.find((model) => model.id === processingSettings.preferredModelId)?.label ??
    processingSettings.preferredModelId ??
    "Preset default";
  const activeTaskCount = tasks.filter(isActiveTask).length;
  const modelResources = useMemo(
    () =>
      resourceOverview?.resources.filter((resource) =>
        ["model", "partialDownload"].includes(resource.kind),
      ) ?? [],
    [resourceOverview],
  );

  async function handleCopy(path: string) {
    await navigator.clipboard.writeText(path);
  }

  async function handleReveal(path: string) {
    setBusyId(path);
    try {
      await revealResource(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to reveal resource.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleClearResource(resource: ResourceItem) {
    setBusyId(resource.id);
    try {
      if (resource.kind === "sessionDir" && resource.sessionId) {
        await deleteSession(resource.sessionId);
        await refreshStorage();
        window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
        setPendingDelete(null);
        return;
      }

      const nextOverview = await deleteResource(resource.path, resource.sessionId, resource.modelId);
      setResourceOverview(nextOverview);
      if (resource.kind === "model" || resource.kind === "partialDownload") {
        await refreshModels();
      }
      if (resource.kind === "sessionDir") {
        window.dispatchEvent(new CustomEvent("leclog:sessions-changed"));
      }
      setPendingDelete(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to clear resource.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDownload(modelId: string) {
    setBusyId(modelId);
    try {
      await downloadTranscriptionModel(modelId);
      await Promise.all([refreshTasks(), refreshModels()]);
      setActivePanel("tasks");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to start model download.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteModel(modelId: string) {
    setBusyId(modelId);
    try {
      await deleteTranscriptionModel(modelId);
      if (processingSettings.preferredModelId === modelId) {
        await updateSettings({ preferredModelId: null });
      }
      await refreshModels();
      setPendingDelete(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete model.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) {
      return;
    }

    if (pendingDelete.kind === "resource") {
      await handleClearResource(pendingDelete.resource);
      return;
    }

    await handleDeleteModel(pendingDelete.modelId);
  }

  function handleLanguageSelectionChange(value: TranscriptionLanguageProfileId) {
    setLanguageSelection(value);
    if (value === "custom") {
      setCustomLanguageDraft(
        processingSettings.language === "auto" ? "" : processingSettings.language,
      );
      return;
    }

    const profile = transcriptionLanguageProfiles.find((item) => item.id === value);
    if (!profile) {
      return;
    }
    void updateSettings({
      language: profile.language,
      promptTerms: profile.promptTerms,
    });
  }

  function handleCustomLanguageChange(value: string) {
    setCustomLanguageDraft(value);
    void updateSettings({ language: value.trim() || "auto" });
  }

  function handleUpdateDownloadEvent(event: DownloadEvent) {
    if (event.event === "Started") {
      setUpdateProgress({
        downloadedBytes: 0,
        totalBytes: event.data.contentLength ?? null,
      });
      return;
    }

    if (event.event === "Progress") {
      setUpdateProgress((current) => ({
        ...current,
        downloadedBytes: current.downloadedBytes + event.data.chunkLength,
      }));
      return;
    }

    setUpdateProgress((current) => ({
      ...current,
      downloadedBytes: current.totalBytes ?? current.downloadedBytes,
    }));
  }

  async function handleCheckForUpdate() {
    setUpdateStatus("checking");
    setUpdateMessage(null);
    setError(null);
    try {
      const update = await check({ timeout: 30_000 });
      setPendingUpdate(update);
      setUpdateProgress({ downloadedBytes: 0, totalBytes: null });
      if (update) {
        setUpdateStatus("available");
        setUpdateMessage(`Version ${update.version} is available.`);
      } else {
        setUpdateStatus("none");
        setUpdateMessage("Leclog is up to date.");
      }
    } catch (reason) {
      setUpdateStatus("error");
      setUpdateMessage(getErrorMessage(reason, "Failed to check for updates."));
    }
  }

  async function handleInstallUpdate() {
    if (!pendingUpdate) {
      return;
    }

    setUpdateStatus("installing");
    setUpdateMessage(null);
    setError(null);
    try {
      await pendingUpdate.downloadAndInstall(handleUpdateDownloadEvent, { timeout: 120_000 });
      setUpdateStatus("installed");
      setUpdateMessage("Update installed. Restart Leclog to finish.");
      await pendingUpdate.close();
      setPendingUpdate(null);
    } catch (reason) {
      setUpdateStatus("error");
      setUpdateMessage(getErrorMessage(reason, "Failed to install update."));
    }
  }

  async function handleCancelTask(taskId: string) {
    setBusyId(taskId);
    try {
      await cancelBackgroundTask(taskId);
      await refreshTasks();
      if (activePanel === "models") {
        await refreshModels();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to cancel task.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetryTask(task: BackgroundTask) {
    if (!canRetryTask(task)) {
      return;
    }

    setBusyId(`retry:${task.id}`);
    setError(null);
    try {
      if (task.kind === "modelDownload" && task.modelId) {
        await downloadTranscriptionModel(task.modelId);
      } else if (task.sessionId) {
        await retrySessionProcessing(task.sessionId);
      }
      await refreshTasks();
      if (task.kind === "modelDownload") {
        await refreshModels();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to retry task.");
    } finally {
      setBusyId(null);
    }
  }

  function handleRefreshCurrentPanel() {
    if (activePanel === "overview") {
      void refreshOverview();
      return;
    }
    void refreshPanel(activePanel);
  }

  if (!isOpen) {
    return null;
  }

  const isBusy = busyId !== null;
  const updatePercent =
    updateProgress.totalBytes && updateProgress.totalBytes > 0
      ? Math.min(100, Math.round((updateProgress.downloadedBytes / updateProgress.totalBytes) * 100))
      : updateStatus === "installed"
        ? 100
        : 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/25 backdrop-blur-[2px]" role="dialog" aria-modal="true">
      <button className="absolute inset-0 cursor-default" type="button" aria-label="Close settings" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-5xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Settings
            </p>
            <h2 className="truncate text-base font-semibold text-slate-950">
              Workspace controls
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={handleRefreshCurrentPanel}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close settings" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          <nav className="min-h-0 border-r border-slate-200 bg-slate-50/70 p-2" aria-label="Settings panels">
            <div className="grid gap-1">
              {panels.map((panel) => (
                <button
                  key={panel.id}
                  type="button"
                  className={[
                    "grid cursor-pointer gap-0.5 rounded-lg px-3 py-2 text-left transition-colors",
                    activePanel === panel.id
                      ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                      : "text-slate-600 hover:bg-white/80 hover:text-slate-950",
                  ].join(" ")}
                  onClick={() => setActivePanel(panel.id)}
                >
                  <span className="text-sm font-medium">{panel.label}</span>
                  <span className="truncate text-xs text-slate-500">{panel.description}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="min-h-0 overflow-y-auto p-4">
            {error ? (
              <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            {activePanel === "overview" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="Runtime health"
                  detail="Dependency checks and app data status."
                  icon={
                    runtimeStatus?.issues.length ? (
                      <AlertTriangle className="size-4 text-amber-600" />
                    ) : (
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    )
                  }
                />
                <div className="grid gap-2 md:grid-cols-5">
                  <Stat
                    label="App data"
                    value={runtimeStatus?.isAppDataWritable ? "Writable" : "Blocked"}
                    detail={runtimeStatus?.appDataDir}
                  />
                  <Stat
                    label="ffmpeg"
                    value={runtimeStatus?.ffmpegAvailable ? "Available" : "Missing"}
                    detail={runtimeStatus?.ffmpegPath ?? undefined}
                  />
                  <Stat
                    label="whisper-cli"
                    value={runtimeStatus?.whisperAvailable ? "Available" : "Missing"}
                    detail={runtimeStatus?.whisperCliPath ?? undefined}
                  />
                  <Stat
                    label="Acceleration"
                    value={
                      runtimeStatus?.whisperAvailable
                        ? runtimeStatus.whisperAccelerationAvailable
                          ? "GPU"
                          : "CPU"
                        : "Missing"
                    }
                    detail={runtimeStatus?.whisperAccelerationLabel ?? undefined}
                  />
                  <Stat label="Active tasks" value={String(activeTaskCount)} detail={`${tasks.length} tracked`} />
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-950">Software update</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        Current version {appVersion ?? "unknown"} · GitHub Releases channel
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={updateStatus === "checking" || updateStatus === "installing"}
                        onClick={() => void handleCheckForUpdate()}
                      >
                        <RefreshCw className="size-3.5" />
                        {updateStatus === "checking" ? "Checking" : "Check"}
                      </Button>
                      {pendingUpdate ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={updateStatus === "installing"}
                          onClick={() => void handleInstallUpdate()}
                        >
                          <Download className="size-3.5" />
                          {updateStatus === "installing" ? "Installing" : "Install"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">
                        Check for updates on startup
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        Runs quietly and only shows a badge when a newer release exists.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      className="size-4 accent-slate-950"
                      checked={appSettings.autoCheckUpdates}
                      disabled={!appSettingsLoaded}
                      onChange={(event) =>
                        void updateAppSettings({ autoCheckUpdates: event.target.checked })
                      }
                    />
                  </label>
                  {updateStatus === "installing" ? (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-slate-950" style={{ width: `${updatePercent}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {updateProgress.totalBytes
                          ? `${formatBytes(updateProgress.downloadedBytes)} / ${formatBytes(updateProgress.totalBytes)}`
                          : "Downloading update..."}
                      </p>
                    </div>
                  ) : null}
                  {updateMessage ? (
                    <p
                      className={[
                        "mt-2 rounded-lg px-3 py-2 text-sm",
                        updateStatus === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-slate-50 text-slate-600",
                      ].join(" ")}
                    >
                      {updateMessage}
                    </p>
                  ) : null}
                </div>
                {runtimeStatus?.issues.length ? (
                  <div className="grid gap-2">
                    {runtimeStatus.issues.map((issue) => (
                      <p key={issue} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        {issue}
                      </p>
                    ))}
                  </div>
                ) : null}
                {resourceOverview ? (
                  <div className="grid gap-2 md:grid-cols-4">
                    <Stat label="Storage" value={formatBytes(resourceOverview.totalBytes)} detail="App data total" />
                    <Stat label="Sessions" value={formatBytes(resourceOverview.sessionBytes)} />
                    <Stat label="Models" value={formatBytes(resourceOverview.modelBytes)} />
                    <Stat label="Processed" value={formatBytes(resourceOverview.processedBytes)} />
                  </div>
                ) : (
                  <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    Storage totals load when you open the Storage panel.
                  </p>
                )}
              </div>
            ) : null}

            {activePanel === "transcription" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="Transcription defaults"
                  detail="Quality preset, language hints, chunking, and CPU use."
                  icon={<SlidersHorizontal className="size-4" />}
                />
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(presetLabels) as ProcessingQualityPreset[]).map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      variant={processingSettings.qualityPreset === preset ? "default" : "outline"}
                      size="sm"
                      disabled={!settingsLoaded}
                      onClick={() => void updateSettings({ qualityPreset: preset })}
                    >
                      {presetLabels[preset]}
                    </Button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Default language</span>
                    <select
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      value={languageSelection}
                      onChange={(event) =>
                        handleLanguageSelectionChange(event.target.value as TranscriptionLanguageProfileId)
                      }
                      disabled={!settingsLoaded}
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
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Preferred model</span>
                    <select
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      value={processingSettings.preferredModelId ?? ""}
                      onChange={(event) =>
                        void updateSettings({ preferredModelId: event.target.value || null })
                      }
                      disabled={!settingsLoaded}
                    >
                      <option value="">Preset default</option>
                      {models.filter((model) => model.installed).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {languageSelection === "custom" ? (
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium text-slate-700">Custom language code</span>
                      <input
                        className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                        value={customLanguageDraft}
                        placeholder="fr, de, es..."
                        onChange={(event) => handleCustomLanguageChange(event.target.value)}
                        disabled={!settingsLoaded}
                      />
                    </label>
                  ) : null}
                </div>
                {modelLanguageWarning ? (
                  <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <span>{modelLanguageWarning}</span>
                  </p>
                ) : null}
                <label className="grid gap-1 text-sm">
                  <span className="font-medium text-slate-700">Prompt terms</span>
                  <input
                    className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                    value={processingSettings.promptTerms}
                    onChange={(event) => void updateSettings({ promptTerms: event.target.value })}
                    disabled={!settingsLoaded}
                  />
                </label>
                <div className="grid gap-2 md:grid-cols-4">
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Chunk minutes</span>
                    <input
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      type="number"
                      min={1}
                      max={60}
                      value={processingSettings.chunkDurationMinutes}
                      onChange={(event) =>
                        void updateSettings({
                          qualityPreset: "custom",
                          chunkDurationMinutes: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Overlap seconds</span>
                    <input
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      type="number"
                      min={0}
                      max={120}
                      value={processingSettings.chunkOverlapSeconds}
                      onChange={(event) =>
                        void updateSettings({
                          qualityPreset: "custom",
                          chunkOverlapSeconds: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Whisper threads</span>
                    <input
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      type="number"
                      min={1}
                      max={16}
                      value={processingSettings.whisperThreads ?? ""}
                      placeholder="Auto"
                      onChange={(event) =>
                        void updateSettings({
                          qualityPreset: "custom",
                          whisperThreads: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium text-slate-700">Live refresh</span>
                    <input
                      className="h-9 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                      type="number"
                      min={10}
                      max={60}
                      value={processingSettings.liveRefreshIntervalSeconds}
                      onChange={(event) =>
                        void updateSettings({
                          qualityPreset: "custom",
                          liveRefreshIntervalSeconds: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {activePanel === "models" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="Model manager"
                  detail={`${installedCount} installed. Preferred: ${preferredModelLabel}.`}
                  icon={<Gauge className="size-4" />}
                />
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                  {models.map((model) => {
                    const isPreferred = processingSettings.preferredModelId === model.id;
                    const canDelete = model.installed && model.managedByApp;
                    const total = model.totalBytes ?? model.sizeBytes;
                    const progress = total ? Math.round((model.downloadedBytes / total) * 100) : 0;
                    return (
                      <div key={model.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-slate-950">
                              {model.label}
                            </p>
                            {model.recommended ? (
                              <Badge variant="outline" className="rounded-md border-teal-200 bg-teal-50 px-1.5 text-[10px] text-teal-700">
                                Recommended
                              </Badge>
                            ) : null}
                            <span className="text-xs text-slate-500">{formatBytes(model.sizeBytes)}</span>
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-500">{model.installedPath ?? model.id}</p>
                          {model.downloadStatus === "downloading" ? (
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                              <div className="h-full rounded-full bg-slate-950" style={{ width: `${progress}%` }} />
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            disabled={!model.installed || isPreferred}
                            onClick={() => void updateSettings({ preferredModelId: model.id })}
                          >
                            {isPreferred ? "Selected" : "Use"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={model.installed || model.downloadStatus === "downloading" || isBusy}
                            onClick={() => void handleDownload(model.id)}
                          >
                            <Download className="size-3.5" />
                            Download
                          </Button>
                          {canDelete ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="icon-sm"
                              title="Delete model"
                              onClick={() => {
                                setError(null);
                                setPendingDelete({ kind: "model", modelId: model.id });
                              }}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {activePanel === "storage" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="App resources"
                  detail="Only Leclog-owned files are shown here."
                  icon={<HardDrive className="size-4" />}
                />
                <div className="grid gap-2 md:grid-cols-4">
                  <Stat label="Total" value={formatBytes(resourceOverview?.totalBytes ?? 0)} />
                  <Stat label="Sessions" value={formatBytes(resourceOverview?.sessionBytes ?? 0)} />
                  <Stat label="Models" value={formatBytes(resourceOverview?.modelBytes ?? 0)} />
                  <Stat label="Temp" value={formatBytes(resourceOverview?.tempBytes ?? 0)} />
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3">
                  {modelResources.length === 0 ? (
                    <p className="py-3 text-sm text-slate-500">No app-level model resources yet.</p>
                  ) : (
                    modelResources.map((resource) => (
                      <ResourceLine
                        key={resource.id}
                        resource={resource}
                        onCopy={(path) => void handleCopy(path)}
                        onReveal={(path) => void handleReveal(path)}
                        onClear={(nextResource) => {
                          setError(null);
                          setPendingDelete({ kind: "resource", resource: nextResource });
                        }}
                      />
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {activePanel === "tasks" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="Background tasks"
                  detail="Downloads, transcription, retry, and cancellation."
                  icon={<Workflow className="size-4" />}
                />
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                  {tasks.length === 0 ? (
                    <p className="p-3 text-sm text-slate-500">No background tasks in this app run.</p>
                  ) : (
                    tasks.map((task) => {
                      const errorSummary = summarizeTaskError(task);
                      const failureMeta = taskFailureMeta(task);
                      const logPath = task.failureLog?.logPath;
                      return (
                        <div key={task.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <p className="truncate text-sm font-semibold text-slate-950">{task.title}</p>
                              <Badge variant="outline" className={taskStatusClass(task.status)}>
                                {task.status}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {task.step} · {Math.round(task.percent)}% · {formatDate(task.updatedAt)}
                            </p>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                              <div className="h-full rounded-full bg-slate-950" style={{ width: `${Math.max(0, Math.min(100, task.percent))}%` }} />
                            </div>
                            {task.error ? (
                              <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700" title={task.error}>
                                {errorSummary ? `Failed: ${errorSummary}` : task.error}
                              </p>
                            ) : null}
                            {failureMeta ? (
                              <p className="mt-1 truncate text-[11px] text-red-500" title={task.failureLog?.command ?? undefined}>
                                {failureMeta}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {canRetryTask(task) ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busyId === `retry:${task.id}`}
                                onClick={() => void handleRetryTask(task)}
                              >
                                <RotateCcw className="size-3.5" />
                                {retryTaskLabel(task)}
                              </Button>
                            ) : null}
                            {logPath ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title="Reveal task log"
                                disabled={busyId === logPath}
                                onClick={() => void handleReveal(logPath)}
                              >
                                <FolderSearch className="size-3.5" />
                                Log
                              </Button>
                            ) : null}
                            {task.cancelable && isActiveTask(task) ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void handleCancelTask(task.id)}>
                                <XCircle className="size-3.5" />
                                Cancel
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}

            {activePanel === "gaps" ? (
              <div className="space-y-3">
                <SectionHeader
                  title="Product gaps"
                  detail="The parts that still need product and engineering follow-through."
                  icon={<ListChecks className="size-4" />}
                />
                <div className="grid gap-2">
                  {productGaps.map((gap) => (
                    <div key={gap.title} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <p className="text-sm font-semibold text-slate-950">{gap.title}</p>
                      <p className="mt-1 text-sm text-slate-500">{gap.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === "resource"
            ? pendingDelete.resource.kind === "sessionDir"
              ? "Clear session resources?"
              : `Clear ${pendingDelete.resource.label}?`
            : "Delete model?"
        }
        description={
          pendingDelete?.kind === "resource"
            ? pendingDelete.resource.kind === "sessionDir"
              ? "This clears the session record and all Leclog-managed files for it."
              : "This clears the selected Leclog-managed app resource. Source files outside app data are not touched."
            : "This removes the local Whisper model file managed by Leclog."
        }
        details={
          pendingDelete?.kind === "resource"
            ? [pendingDelete.resource.path]
            : pendingDelete?.kind === "model"
              ? [pendingDelete.modelId]
              : []
        }
        confirmLabel={
          pendingDelete?.kind === "resource"
            ? pendingDelete.resource.kind === "sessionDir"
              ? "Clear all"
              : "Clear resource"
            : "Delete model"
        }
        isBusy={isBusy}
        error={error}
        onCancel={() => {
          if (!isBusy) {
            setPendingDelete(null);
            setError(null);
          }
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
