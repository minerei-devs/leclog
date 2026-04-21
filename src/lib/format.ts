export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const base = [minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");

  return hours > 0 ? `${hours.toString().padStart(2, "0")}:${base}` : base;
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
}
