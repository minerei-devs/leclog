import { useEffect, useState } from "react";
import { getLiveDurationMs } from "../lib/session";
import type { LectureSession } from "../types/session";

export function useLiveSessionDuration(session: LectureSession | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!session || session.status !== "recording") {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [session]);

  if (!session) {
    return 0;
  }

  return getLiveDurationMs(session, now);
}
