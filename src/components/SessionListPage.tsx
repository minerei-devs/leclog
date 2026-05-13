import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, Import, Play, Settings2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNavigate } from "react-router-dom";
import { useRecentState } from "@/hooks/useRecentState";
import { useProcessingSettings } from "@/hooks/useProcessingSettings";
import { getErrorMessage } from "@/lib/errors";
import { getSessionHref } from "@/lib/session";
import { buildDefaultDraftTitle } from "@/lib/store";
import { createSession, importMediaSession, listSessions, startSessionRecording } from "@/lib/tauri";
import type { CaptureSource, LectureSession } from "@/types/session";
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

export function SessionListPage() {
  const navigate = useNavigate();
  const { recentState, isLoaded, updateRecentState } = useRecentState();
  const { settings: processingSettings } = useProcessingSettings();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCaptureSource, setDraftCaptureSource] =
    useState<CaptureSource>("microphone");
  const [isStarting, setIsStarting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listSessions().then(setSessions).catch(() => {});
  }, []);

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
                await importMediaSession(path, undefined, processingSettings),
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
  }, [navigate, processingSettings]);

  async function handleStartSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsStarting(true);

    try {
      const created = await createSession(draftTitle, draftCaptureSource);
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

        <div
          className="flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600"
          title="Default transcription settings. App-wide settings are managed in Settings."
        >
          <span className="font-medium text-slate-950">
            {processingSettings.qualityPreset}
          </span>
          <span className="max-w-48 truncate">
            {processingSettings.preferredModelId ?? "Preset model"}
          </span>
          <span>{processingSettings.language}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Open settings"
            title="Open settings"
            onClick={() => window.dispatchEvent(new CustomEvent("leclog:open-settings"))}
          >
            <Settings2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <RuntimeSetupPanel />

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.58fr)]">
        <form
          className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
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

            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" className="px-3">
                <Play className="size-4" />
                {isStarting ? "Starting..." : "Start recording"}
              </Button>

              {activeSession ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="px-3"
                  onClick={() => navigate(`/recording/${activeSession.id}`)}
                >
                  <ArrowUpRight className="size-4" />
                  Reopen active
                </Button>
              ) : null}
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

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
    </section>
  );
}
