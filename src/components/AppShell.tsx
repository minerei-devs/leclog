import type { PropsWithChildren } from "react";
import { useEffect, useMemo, useState } from "react";
import { FolderCog, Plus, Waves } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listSessions } from "@/lib/tauri";
import { getCaptureSourceLabel, getSessionHref } from "@/lib/session";
import type { LectureSession } from "@/types/session";
import { useSessionPolling } from "@/hooks/useSessionPolling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

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

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const hasActiveProcessing = sessions.some(
    (session) =>
      session.status !== "done" ||
      session.transcriptPhase === "processing" ||
      session.transcriptPhase === "live",
  );

  useEffect(() => {
    let isMounted = true;

    void listSessions()
      .then((result) => {
        if (isMounted) {
          setSessions(result);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  useSessionPolling({
    enabled: hasActiveProcessing,
    intervalMs: 1500,
    onSessions: setSessions,
  });

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [sessions],
  );

  return (
    <div className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(170,201,243,0.22),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#eef2f7_100%)] text-slate-950">
      <div className="grid h-full grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex h-screen flex-col border-r border-slate-200/80 bg-white/80 backdrop-blur-xl">
          <div className="px-3.5 pb-4 pt-4.5">
            <div className="mb-4.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Minerei
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                Leclog
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Local-first lecture capture workspace.
              </p>
            </div>

            <div className="grid gap-2">
              <Link
                className="inline-flex h-9.5 items-center justify-start gap-2 rounded-lg bg-slate-950 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-900"
                to="/new"
              >
                <Plus className="size-4 text-white" />
                <span className="text-white">New session</span>
              </Link>

              <Button asChild variant="ghost" className="h-9 justify-start rounded-lg px-3">
                <Link to="/settings">
                  <FolderCog className="size-4" />
                  Settings
                </Link>
              </Button>
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between px-3.5 py-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Sessions
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {sortedSessions.length === 0
                  ? "No local sessions yet"
                  : `${sortedSessions.length} saved locally`}
              </p>
            </div>
            <Badge variant="outline" className="rounded-full border-slate-200 px-2.5 py-1">
              {sortedSessions.length}
            </Badge>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2 px-2.5 pb-4 pr-4">
              {sortedSessions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-sm text-slate-500">
                  New sessions and imported media will appear here.
                </div>
              ) : (
                sortedSessions.map((session) => {
                  const href = getSessionHref(session);
                  const isActive =
                    location.pathname === href ||
                    location.pathname.endsWith(`/session/${session.id}`) ||
                    location.pathname.endsWith(`/recording/${session.id}`);

                  return (
                    <NavLink
                      key={session.id}
                      to={href}
                      className={cn(
                        "block rounded-xl border border-transparent bg-transparent px-2.5 py-2.5 transition-colors hover:border-slate-200 hover:bg-slate-50/80",
                        isActive && "border-slate-200 bg-white shadow-sm",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-950">
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

                      <p className="mt-2 truncate text-[11px] text-slate-500">
                        {getCaptureSourceLabel(session.captureSource)} ({formatDuration(session.durationMs)})
                      </p>

                      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                        <div className="flex min-w-0 items-center gap-2">
                          <Waves className="size-3.5 shrink-0" />
                          <span className="truncate">
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
          <div className="mx-auto w-full max-w-6xl px-8 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
