import type { BackgroundTask } from "@/types/session";

export function isActiveTask(task: BackgroundTask) {
  return task.status === "queued" || task.status === "running";
}

export function summarizeTaskError(task: BackgroundTask) {
  const rawError = task.error?.trim() || task.failureLog?.stderrExcerpt?.trim();
  if (!rawError) {
    return null;
  }

  const firstLine = rawError.split(/\r?\n/).find((line) => line.trim().length > 0) ?? rawError;
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

export function taskFailureMeta(task: BackgroundTask) {
  const parts: string[] = [];
  if (task.failureLog?.commandLabel) {
    parts.push(task.failureLog.commandLabel);
  }
  if (typeof task.failureLog?.exitCode === "number") {
    parts.push(`exit ${task.failureLog.exitCode}`);
  }
  if (task.failureLog?.logPath) {
    parts.push("log saved");
  }
  return parts.join(" · ");
}

export function canRetryTask(task: BackgroundTask) {
  if (task.status !== "failed") {
    return false;
  }

  if (
    (task.kind === "finalTranscription" || task.kind === "liveTranscription") &&
    task.sessionId
  ) {
    return true;
  }

  return task.kind === "modelDownload" && Boolean(task.modelId);
}

export function retryTaskLabel(task: BackgroundTask) {
  if (task.kind === "modelDownload") {
    return "Retry download";
  }
  return "Retry processing";
}
