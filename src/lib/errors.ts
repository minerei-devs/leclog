export function getErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }

  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }

  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string" &&
    reason.message.trim()
  ) {
    return reason.message;
  }

  return fallback;
}
