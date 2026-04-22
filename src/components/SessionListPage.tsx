import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, Import, Play, Settings2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Link, useNavigate } from "react-router-dom";
import { useRecentState } from "@/hooks/useRecentState";
import { useTranscriptionSettings } from "@/hooks/useTranscriptionSettings";
import { getErrorMessage } from "@/lib/errors";
import { getSessionHref } from "@/lib/session";
import { buildDefaultDraftTitle } from "@/lib/store";
import { createSession, importMediaSession, listSessions, startSessionRecording } from "@/lib/tauri";
import type { CaptureSource, LectureSession } from "@/types/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
        "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-4 transition-colors",
        checked
          ? "border-slate-900 bg-slate-950 text-slate-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
      ].join(" ")}
    >
      <RadioGroupItem
        value={value}
        checked={checked}
        className={checked ? "border-white bg-white text-slate-950" : ""}
        onClick={() => onSelect(value)}
      />
      <div className="space-y-1">
        <div className={checked ? "text-sm font-medium text-white" : "text-sm font-medium"}>
          {title}
        </div>
        <p className={checked ? "text-sm text-slate-300" : "text-sm text-slate-500"}>
          {description}
        </p>
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
  const { settings: transcriptionSettings } = useTranscriptionSettings();
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
                await importMediaSession(path, undefined, transcriptionSettings),
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
  }, [navigate, transcriptionSettings]);

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
    <section className="space-y-6">
      <div className="space-y-2">
        <Badge variant="outline" className="rounded-full border-slate-200 px-3 py-1">
          New Session
        </Badge>
        <h2 className="text-3xl font-semibold tracking-tight text-slate-950">
          Capture a fresh lecture session
        </h2>
        <p className="max-w-2xl text-sm text-slate-500">
          Start recording on the left, or import existing audio and video on the right.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
        <div className="min-w-0">
          <div className="bg-transparent pr-2">
            <CardHeader className="px-0 pb-5">
              <CardTitle className="text-xl">Start recording</CardTitle>
              <CardDescription>
                Use a date-based session name by default, then choose your capture source.
              </CardDescription>
            </CardHeader>

            <form className="space-y-6" onSubmit={handleStartSession}>
              <div className="space-y-2">
                <Label htmlFor="session-title">Session title</Label>
                <Input
                  id="session-title"
                  value={draftTitle}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    setDraftTitle(nextTitle);
                    void updateRecentState({ draftTitle: nextTitle });
                  }}
                  placeholder="2026-04-22 14:30"
                  className="h-11 rounded-lg border-slate-200 bg-white"
                />
              </div>

              <div className="space-y-3">
                <Label>Recording source</Label>
                <RadioGroup
                  value={draftCaptureSource}
                  onValueChange={(value) => {
                    const nextValue = value as CaptureSource;
                    setDraftCaptureSource(nextValue);
                    void updateRecentState({ draftCaptureSource: nextValue });
                  }}
                  className="grid gap-3"
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

              <div className="flex flex-wrap gap-3">
                <Button type="submit" size="lg" className="rounded-lg px-4">
                  <Play className="size-4" />
                  {isStarting ? "Starting..." : "Start recording"}
                </Button>

                {activeSession ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="rounded-lg px-4"
                    onClick={() => navigate(`/recording/${activeSession.id}`)}
                  >
                    <ArrowUpRight className="size-4" />
                    Reopen active
                  </Button>
                ) : null}
              </div>
            </form>
          </div>
        </div>

        <div className="min-w-0">
          <div className="pl-0 lg:pl-2">
            <CardHeader className="px-0 pb-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-xl">Import media</CardTitle>
                  <CardDescription>
                    Drop audio or video files to create transcript-only sessions.
                  </CardDescription>
                </div>
                <Import className="mt-0.5 size-4 text-slate-500" />
              </div>
            </CardHeader>

            <div
              className={[
                "grid min-h-56 place-items-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
                isImportDragActive
                  ? "border-slate-900 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-950",
              ].join(" ")}
            >
              <div className="space-y-3">
                <p className="text-base font-medium">
                  {isImporting ? "Importing media..." : "Drop audio or video files here"}
                </p>
                <p className={isImportDragActive ? "text-sm text-slate-300" : "text-sm text-slate-500"}>
                  Imported files are normalized with ffmpeg and transcribed in the background.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-500">Preferred model</span>
                <span className="font-medium text-slate-950">
                  {transcriptionSettings.preferredModelId ?? "Auto-detect recommended"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-500">Language</span>
                <span className="font-medium text-slate-950">
                  {transcriptionSettings.preferredLanguage}
                </span>
              </div>
            </div>

            <Button asChild variant="ghost" className="mt-4 rounded-lg px-0 text-slate-600">
              <Link to="/settings">
                <Settings2 className="size-4" />
                Open settings
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
    </section>
  );
}
