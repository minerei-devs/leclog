import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FolderCog,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import {
  downloadTranscriptionModel,
  getRuntimeStatus,
  listAvailableTranscriptionModels,
} from "@/lib/tauri";
import type { ManagedTranscriptionModel, RuntimeStatus } from "@/types/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface RuntimeSetupPanelProps {
  showWhenReady?: boolean;
  className?: string;
}

const WHISPER_INSTALL_COMMAND = "brew install whisper-cpp";

function runtimeSource(path: string | null, binaryName: string) {
  if (!path) {
    return "Not resolved";
  }
  if (path.includes(`/binaries/${binaryName}`) || path.includes(`${binaryName}-aarch64-apple-darwin`)) {
    return "App sidecar";
  }
  if (path.includes("/opt/homebrew") || path.includes("/usr/local")) {
    return "Homebrew";
  }
  if (path === binaryName) {
    return "PATH";
  }
  return path;
}

function readinessTone(isReady: boolean) {
  return isReady
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-amber-200 bg-amber-50 text-amber-800";
}

function openSettingsPanel(panel: "overview" | "models" | "tasks") {
  window.dispatchEvent(
    new CustomEvent("leclog:open-settings", {
      detail: { panel },
    }),
  );
}

export function RuntimeSetupPanel({ showWhenReady = false, className = "" }: RuntimeSetupPanelProps) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ManagedTranscriptionModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextRuntimeStatus, nextModels] = await Promise.all([
      getRuntimeStatus(),
      listAvailableTranscriptionModels(),
    ]);
    setRuntimeStatus(nextRuntimeStatus);
    setModels(nextModels);
    setError(null);
  }, []);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    void refresh()
      .catch((reason) => {
        if (isMounted) {
          setError(reason instanceof Error ? reason.message : "Failed to check runtime setup.");
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
  }, [refresh]);

  const recommendedModel = useMemo(
    () => models.find((model) => model.recommended) ?? models[0] ?? null,
    [models],
  );

  const isReady = Boolean(
    runtimeStatus?.isAppDataWritable &&
      runtimeStatus.ffmpegAvailable &&
      runtimeStatus.whisperAvailable &&
      runtimeStatus.installedModelCount > 0,
  );

  if (!showWhenReady && isReady) {
    return null;
  }

  async function handleDownloadModel(model: ManagedTranscriptionModel) {
    setBusyModelId(model.id);
    setError(null);
    try {
      await downloadTranscriptionModel(model.id);
      await refresh();
      openSettingsPanel("tasks");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to start model download.");
    } finally {
      setBusyModelId(null);
    }
  }

  async function handleCopyWhisperCommand() {
    try {
      await navigator.clipboard.writeText(WHISPER_INSTALL_COMMAND);
      setCopiedCommand(true);
      window.setTimeout(() => setCopiedCommand(false), 1400);
    } catch {
      setError(`Install command: ${WHISPER_INSTALL_COMMAND}`);
    }
  }

  const missingWhisper = runtimeStatus ? !runtimeStatus.whisperAvailable : false;
  const missingModel = runtimeStatus ? runtimeStatus.installedModelCount === 0 : false;
  const missingFfmpeg = runtimeStatus ? !runtimeStatus.ffmpegAvailable : false;
  const hasPartialDownloads = Boolean(runtimeStatus && runtimeStatus.partialDownloadCount > 0);

  return (
    <section className={["rounded-lg border border-slate-200 bg-white p-3 shadow-sm", className].join(" ")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {isReady ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="size-4 shrink-0 text-amber-600" />
            )}
            <h3 className="truncate text-sm font-semibold text-slate-950">
              Runtime setup
            </h3>
            <Badge variant="outline" className={["rounded-full px-2 text-[10px]", readinessTone(isReady)].join(" ")}>
              {isReady ? "Ready" : isLoading ? "Checking" : "Action needed"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            ffmpeg ships with the macOS app. Whisper can use an app sidecar or Homebrew. Models are downloaded into app data.
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            Check
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" title="Open runtime settings" onClick={() => openSettingsPanel("overview")}>
            <FolderCog className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">ffmpeg</span>
            <Badge variant="outline" className={["rounded-full px-2 text-[10px]", readinessTone(Boolean(runtimeStatus?.ffmpegAvailable))].join(" ")}>
              {runtimeStatus?.ffmpegAvailable ? "Ready" : "Missing"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500" title={runtimeStatus?.ffmpegPath ?? undefined}>
            {runtimeSource(runtimeStatus?.ffmpegPath ?? null, "ffmpeg")}
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">whisper-cli</span>
            <Badge variant="outline" className={["rounded-full px-2 text-[10px]", readinessTone(Boolean(runtimeStatus?.whisperAvailable))].join(" ")}>
              {runtimeStatus?.whisperAvailable ? "Ready" : "Missing"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500" title={runtimeStatus?.whisperCliPath ?? undefined}>
            {runtimeSource(runtimeStatus?.whisperCliPath ?? null, "whisper-cli")}
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-700">Model</span>
            <Badge variant="outline" className={["rounded-full px-2 text-[10px]", readinessTone(Boolean(runtimeStatus?.installedModelCount))].join(" ")}>
              {runtimeStatus?.installedModelCount ? "Ready" : "Missing"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500" title={runtimeStatus?.installedModelLabels.join(", ")}>
            {runtimeStatus?.installedModelLabels.length
              ? runtimeStatus.installedModelLabels.join(", ")
              : "Download into app data"}
          </p>
        </div>
      </div>

      {!isReady ? (
        <div className="mt-3 grid gap-2">
          {missingModel && recommendedModel ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
              <p className="min-w-0 text-xs text-amber-900">
                No Whisper model is installed. Start with {recommendedModel.label} ({formatBytes(recommendedModel.sizeBytes)}).
              </p>
              <Button
                type="button"
                size="sm"
                disabled={busyModelId === recommendedModel.id || recommendedModel.downloadStatus === "downloading"}
                onClick={() => void handleDownloadModel(recommendedModel)}
              >
                <Download className="size-3.5" />
                {recommendedModel.downloadStatus === "downloading" ? "Downloading" : "Download"}
              </Button>
            </div>
          ) : null}

          {missingWhisper ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
              <p className="min-w-0 text-xs text-amber-900">
                whisper-cli is not bundled in this build. Install it with Homebrew, then recheck.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyWhisperCommand()}>
                {copiedCommand ? <CheckCircle2 className="size-3.5" /> : <Copy className="size-3.5" />}
                {copiedCommand ? "Copied" : WHISPER_INSTALL_COMMAND}
              </Button>
            </div>
          ) : null}

          {missingFfmpeg ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2">
              <p className="min-w-0 text-xs text-red-800">
                ffmpeg should be included with Leclog. Reinstall the app or set LECLOG_FFMPEG_PATH.
              </p>
              <Terminal className="size-3.5 text-red-700" />
            </div>
          ) : null}

          {hasPartialDownloads ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
              <p className="min-w-0 text-xs text-slate-600">
                {runtimeStatus?.partialDownloadCount} partial model download(s) remain.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => openSettingsPanel("models")}>
                Open models
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
