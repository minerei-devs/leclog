import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, Clock3, FolderCog, FolderSearch, Plus, RotateCcw, Waves, XCircle } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { check } from "@tauri-apps/plugin-updater";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  cancelBackgroundTask,
  downloadTranscriptionModel,
  listBackgroundTasks,
  listSessions,
  revealResource,
  retrySessionProcessing,
} from "@/lib/tauri";
import { getCaptureSourceLabel, getSessionHref } from "@/lib/session";
import {
  canRetryTask,
  isActiveTask,
  retryTaskLabel,
  summarizeTaskError,
  taskFailureMeta,
} from "@/lib/tasks";
import type { BackgroundTask, LectureSession } from "@/types/session";
import { useAppSettings } from "@/hooks/useAppSettings";
import { useSessionPolling } from "@/hooks/useSessionPolling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { SettingsPage } from "./SettingsPage";
import type { SettingsPanelId } from "./SettingsPage";

function sessionBadgeClass(session: LectureSession) {
  if (session.status === "recording") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (session.status === "processing" || session.transcriptPhase === "processing") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (session.status === "paused") {
    return "border-orange-200 bg-orange-50 text-orange-700";
  }

  if (session.status === "done") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  return "border-slate-200 bg-slate-100 text-slate-600";
}

function formatSidebarTime(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

function isVisibleSessionTask(task: BackgroundTask) {
  return Boolean(task.sessionId) && (isActiveTask(task) || task.status === "failed");
}

function sessionTaskStage(task: BackgroundTask) {
  const step = task.step.toLowerCase();
  if (task.status === "queued") {
    return 0;
  }
  if (step.includes("normal")) {
    return 1;
  }
  if (step.includes("transcrib") || step.includes("chunk")) {
    return 2;
  }
  if (step.includes("polish")) {
    return 3;
  }
  return Math.max(1, Math.min(3, Math.ceil(task.percent / 34)));
}

function sessionTaskTone(task: BackgroundTask) {
  if (task.status === "failed") {
    return "bg-red-500";
  }
  if (task.status === "queued") {
    return "bg-slate-400";
  }
  return "bg-blue-600";
}

function taskStatusClass(status: BackgroundTask["status"]) {
  if (status === "running" || status === "queued") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (status === "failed") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function formatEtaDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "<1m";
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return "<1m";
  }

  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function estimateTaskEta(task: BackgroundTask) {
  if (task.status === "queued") {
    return "waiting";
  }
  if (task.status === "failed") {
    return "failed";
  }
  if (task.status === "succeeded") {
    return "done";
  }
  if (task.percent <= 1 || task.percent >= 100) {
    return "calculating";
  }

  const elapsedMs = Date.now() - new Date(task.createdAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "calculating";
  }

  const remainingMs = (elapsedMs / task.percent) * (100 - task.percent);
  return `~${formatEtaDuration(remainingMs)} left`;
}

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const navigate = useNavigate();
  const { settings: appSettings, isLoaded: appSettingsLoaded } = useAppSettings();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialPanel, setSettingsInitialPanel] = useState<SettingsPanelId>("overview");
  const [isTaskPanelOpen, setIsTaskPanelOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [taskPanelError, setTaskPanelError] = useState<string | null>(null);
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState<string | null>(null);
  const hasActiveProcessing = sessions.some(
    (session) =>
      session.status !== "done" ||
      session.transcriptPhase === "processing" ||
      session.transcriptPhase === "live",
  );

  const refreshShellData = useCallback(async () => {
    const [result, nextTasks] = await Promise.all([listSessions(), listBackgroundTasks()]);
    setSessions(result);
    setTasks(nextTasks);
  }, []);

  useEffect(() => {
    let isMounted = true;

    void Promise.all([listSessions(), listBackgroundTasks()])
      .then(([result, nextTasks]) => {
        if (isMounted) {
          setSessions(result);
          setTasks(nextTasks);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    function handleSessionsChanged() {
      void refreshShellData().catch(() => {});
    }

    window.addEventListener("leclog:sessions-changed", handleSessionsChanged);
    return () => {
      window.removeEventListener("leclog:sessions-changed", handleSessionsChanged);
    };
  }, [refreshShellData]);

  useSessionPolling({
    enabled: hasActiveProcessing,
    intervalMs: 1500,
    onSessions: setSessions,
  });

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void listBackgroundTasks().then(setTasks).catch(() => {});
    }, 2000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!appSettingsLoaded || !appSettings.autoCheckUpdates) {
      return;
    }

    let isMounted = true;
    void check({ timeout: 15_000 })
      .then(async (update) => {
        if (!update) {
          return;
        }
        if (isMounted) {
          setAvailableUpdateVersion(update.version);
        }
        await update.close();
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [appSettings.autoCheckUpdates, appSettingsLoaded]);

  useEffect(() => {
    function isSettingsPanelId(value: unknown): value is SettingsPanelId {
      return (
        value === "overview" ||
        value === "transcription" ||
        value === "models" ||
        value === "storage" ||
        value === "tasks" ||
        value === "gaps"
      );
    }

    function handleOpenSettings(event: Event) {
      const panel = event instanceof CustomEvent ? event.detail?.panel : null;
      if (isSettingsPanelId(panel)) {
        setSettingsInitialPanel(panel);
      }
      setIsSettingsOpen(true);
    }

    window.addEventListener("leclog:open-settings", handleOpenSettings);
    return () => {
      window.removeEventListener("leclog:open-settings", handleOpenSettings);
    };
  }, []);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    ),
    [sessions],
  );
  const activeTaskCount = tasks.filter(isActiveTask).length;
  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((task) => isActiveTask(task) || task.status === "failed")
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        ),
    [tasks],
  );
  const sessionTasksById = useMemo(() => {
    const entries = tasks
      .filter(isVisibleSessionTask)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );

    return entries.reduce<Record<string, BackgroundTask>>((result, task) => {
      if (task.sessionId && !result[task.sessionId]) {
        result[task.sessionId] = task;
      }
      return result;
    }, {});
  }, [tasks]);

  async function handleCancelTask(taskId: string) {
    setBusyTaskId(taskId);
    setTaskPanelError(null);
    try {
      await cancelBackgroundTask(taskId);
      await refreshShellData();
    } catch (reason) {
      setTaskPanelError(reason instanceof Error ? reason.message : "Failed to cancel task.");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleRetryTask(task: BackgroundTask) {
    if (!canRetryTask(task)) {
      return;
    }

    setBusyTaskId(task.id);
    setTaskPanelError(null);
    try {
      if (task.kind === "modelDownload" && task.modelId) {
        await downloadTranscriptionModel(task.modelId);
      } else if (task.sessionId) {
        await retrySessionProcessing(task.sessionId);
      }
      await refreshShellData();
    } catch (reason) {
      setTaskPanelError(reason instanceof Error ? reason.message : "Failed to retry task.");
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleRevealTaskLog(task: BackgroundTask) {
    if (!task.failureLog?.logPath) {
      return;
    }

    setBusyTaskId(`log:${task.id}`);
    setTaskPanelError(null);
    try {
      await revealResource(task.failureLog.logPath);
    } catch (reason) {
      setTaskPanelError(reason instanceof Error ? reason.message : "Failed to reveal task log.");
    } finally {
      setBusyTaskId(null);
    }
  }

  function handleOpenTaskSession(task: BackgroundTask) {
    if (!task.sessionId) {
      return;
    }

    const session = sessions.find((candidate) => candidate.id === task.sessionId);
    navigate(session ? getSessionHref(session) : `/session/${task.sessionId}`);
  }

  return (
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(170,201,243,0.22),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] text-slate-950">
      <div className="grid h-full grid-cols-[248px_minmax(0,1fr)]">
        <aside className="flex h-screen flex-col border-r border-slate-200/80 bg-white/80 backdrop-blur-xl">
          <div className="px-3 pb-3 pt-3.5">
            <div className="mb-3.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Minerei
              </p>
              <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-slate-950">
                Leclog
              </h1>
              <p className="mt-0.5 truncate text-xs text-slate-500" title="Local-first lecture capture workspace.">
                Local-first lecture capture workspace.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Link
                className="inline-flex h-8.5 items-center justify-start gap-2 rounded-lg bg-slate-950 px-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-900"
                to="/new"
              >
                <Plus className="size-4 text-white" />
                <span className="text-white">New session</span>
              </Link>

              <Button
                type="button"
                variant="ghost"
                className="h-8.5 justify-start rounded-lg px-2.5"
                onClick={() => {
                  setSettingsInitialPanel("overview");
                  setIsSettingsOpen(true);
                }}
              >
                <FolderCog className="size-4" />
                Settings
                {availableUpdateVersion ? (
                  <Badge
                    variant="outline"
                    className="ml-auto rounded-full border-orange-200 bg-orange-50 px-2 text-orange-700"
                  >
                    Update
                  </Badge>
                ) : activeTaskCount > 0 ? (
                    <Badge
                      variant="outline"
                      className="ml-auto rounded-full border-blue-200 bg-blue-50 px-2 text-blue-700"
                    >
                      {activeTaskCount}
                    </Badge>
                ) : null}
              </Button>
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between px-3 py-2.5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Sessions
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {sortedSessions.length === 0
                  ? "No local sessions yet"
                  : `${sortedSessions.length} saved locally`}
              </p>
            </div>
            <Badge variant="outline" className="rounded-full border-slate-200 px-2 py-0.5 text-[11px]">
              {sortedSessions.length}
            </Badge>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 px-2 pb-4 pr-3">
              {sortedSessions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-4 text-xs text-slate-500">
                  New sessions and imported media will appear here.
                </div>
              ) : (
                sortedSessions.map((session) => {
                  const href = getSessionHref(session);
                  const task = sessionTasksById[session.id];
                  const taskStage = task ? sessionTaskStage(task) : 0;
                  const taskPercent = task
                    ? Math.max(0, Math.min(100, Math.round(task.percent)))
                    : 0;
                  const chunkLabel =
                    task && task.totalChunks > 0
                      ? `${task.completedChunks}/${task.totalChunks} chunks`
                      : null;
                  const isActive =
                    location.pathname === href ||
                    location.pathname.endsWith(`/session/${session.id}`) ||
                    location.pathname.endsWith(`/recording/${session.id}`);

                  return (
                    <NavLink
                      key={session.id}
                      to={href}
                      className={cn(
                        "block w-full max-w-full overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-2 transition-colors hover:border-slate-200 hover:bg-slate-50/80",
                        isActive && "border-slate-200 bg-white shadow-sm",
                      )}
                      title={`${session.title} · ${getCaptureSourceLabel(session.captureSource)} · ${session.transcriptPhase}`}
                    >
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                        <div className="min-w-0 overflow-hidden">
                          <p className="block max-w-full truncate text-sm font-medium text-slate-950">
                            {session.title}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] capitalize",
                            sessionBadgeClass(session),
                          )}
                        >
                          {session.status}
                        </Badge>
                      </div>

                      <p className="mt-1.5 block max-w-full truncate text-[11px] text-slate-500">
                        {getCaptureSourceLabel(session.captureSource)} ({formatDuration(session.durationMs)})
                      </p>

                      {task ? (
                        <div
                          className="mt-1.5 rounded-md border border-slate-200 bg-white/80 px-2 py-1.5"
                          title={`${task.title}: ${task.step} (${taskPercent}%)${task.error ? ` · ${task.error}` : ""}`}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                            <span className="min-w-0 truncate">{task.step}</span>
                            <span className="shrink-0 tabular-nums">{taskPercent}%</span>
                          </div>
                          <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={cn("h-full rounded-full transition-all", sessionTaskTone(task))}
                              style={{ width: `${taskPercent}%` }}
                            />
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1">
                              {[0, 1, 2, 3].map((stage) => (
                                <span
                                  key={stage}
                                  className={cn(
                                    "size-1.5 rounded-full",
                                    stage <= taskStage
                                      ? task.status === "failed"
                                        ? "bg-red-500"
                                        : "bg-blue-600"
                                      : "bg-slate-200",
                                  )}
                                />
                              ))}
                            </div>
                            {chunkLabel ? (
                              <span className="truncate text-[10px] text-slate-400">
                                {chunkLabel}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-500">
                        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <Waves className="size-3.5 shrink-0" />
                          <span className="block max-w-full truncate">
                            {session.segments.length} segments · {session.transcriptPhase}
                          </span>
                        </div>
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
                          {formatSidebarTime(session.updatedAt)}
                        </span>
                      </div>
                    </NavLink>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </aside>

        <main className="h-screen overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-5 py-5">{children}</div>
        </main>
      </div>
      {visibleTasks.length > 0 || availableUpdateVersion ? (
        <div className="fixed bottom-4 right-4 z-40 w-[min(360px,calc(100vw-2rem))]">
          {isTaskPanelOpen ? (
            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-slate-950">Background tasks</h2>
                  <p className="truncate text-xs text-slate-500">
                    {activeTaskCount} active, {visibleTasks.length} visible
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Collapse background tasks"
                  onClick={() => setIsTaskPanelOpen(false)}
                >
                  <XCircle className="size-4" />
                </Button>
              </div>

              <div className="max-h-80 overflow-y-auto px-3">
                {availableUpdateVersion ? (
                  <div className="my-2 flex items-center justify-between gap-2 rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-2">
                    <p className="min-w-0 truncate text-xs text-orange-800">
                      Leclog {availableUpdateVersion} is available.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setSettingsInitialPanel("overview");
                        setIsSettingsOpen(true);
                      }}
                    >
                      Open
                    </Button>
                  </div>
                ) : null}
                {taskPanelError ? (
                  <p className="my-2 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700">
                    {taskPanelError}
                  </p>
                ) : null}
                {visibleTasks.map((task) => {
                  const percent = Math.max(0, Math.min(100, Math.round(task.percent)));
                  const chunkLabel =
                    task.totalChunks > 0
                      ? `${task.completedChunks}/${task.totalChunks} chunks`
                      : null;
                  const errorSummary = summarizeTaskError(task);
                  const failureMeta = taskFailureMeta(task);

                  return (
                    <article key={task.id} className="border-b border-slate-100 py-2 last:border-b-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-950">
                            {task.title}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">
                            {task.step}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px]", taskStatusClass(task.status))}
                        >
                          {task.status}
                        </Badge>
                      </div>

                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={cn("h-full rounded-full transition-all", sessionTaskTone(task))}
                          style={{ width: `${percent}%` }}
                        />
                      </div>

                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="tabular-nums">{percent}%</span>
                        {chunkLabel ? <span>{chunkLabel}</span> : null}
                        <span className="ml-auto inline-flex items-center gap-1">
                          <Clock3 className="size-3" />
                          {estimateTaskEta(task)}
                        </span>
                      </div>

                      {task.error ? (
                        <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700" title={task.error}>
                          {errorSummary ? `Failed: ${errorSummary}` : task.error}
                        </p>
                      ) : null}
                      {failureMeta ? (
                        <p className="mt-1 truncate text-[11px] text-red-500" title={task.failureLog?.command ?? undefined}>
                          {failureMeta}
                        </p>
                      ) : null}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {canRetryTask(task) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={busyTaskId === task.id}
                            onClick={() => void handleRetryTask(task)}
                          >
                            <RotateCcw className="size-3" />
                            {retryTaskLabel(task)}
                          </Button>
                        ) : null}
                        {task.sessionId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => handleOpenTaskSession(task)}
                          >
                            <ArrowUpRight className="size-3" />
                            Open session
                          </Button>
                        ) : null}
                        {task.failureLog?.logPath ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            title="Reveal task log"
                            disabled={busyTaskId === `log:${task.id}`}
                            onClick={() => void handleRevealTaskLog(task)}
                          >
                            <FolderSearch className="size-3" />
                            Log
                          </Button>
                        ) : null}
                        {task.cancelable && isActiveTask(task) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={busyTaskId === task.id}
                            onClick={() => void handleCancelTask(task.id)}
                          >
                            <XCircle className="size-3" />
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : (
            <button
              type="button"
              className="ml-auto flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-950 shadow-xl transition-colors hover:bg-slate-50"
              onClick={() => setIsTaskPanelOpen(true)}
            >
              <Activity className="size-4 text-blue-600" />
              <span>
                {activeTaskCount || visibleTasks.length
                  ? `${activeTaskCount || visibleTasks.length} task${(activeTaskCount || visibleTasks.length) === 1 ? "" : "s"}`
                  : "Update available"}
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                {visibleTasks[0] ? `${Math.round(visibleTasks[0].percent)}%` : availableUpdateVersion}
              </span>
            </button>
          )}
        </div>
      ) : null}
      <SettingsPage
        isOpen={isSettingsOpen}
        initialPanel={settingsInitialPanel}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
