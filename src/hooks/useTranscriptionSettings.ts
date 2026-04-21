import { useCallback, useEffect, useState } from "react";
import {
  defaultTranscriptionSettings,
  getTranscriptionSettings,
  patchTranscriptionSettings,
} from "../lib/store";
import type { TranscriptionSettings } from "../types/session";

export function useTranscriptionSettings() {
  const [settings, setSettings] = useState<TranscriptionSettings>(
    defaultTranscriptionSettings,
  );
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void getTranscriptionSettings()
      .then((value) => {
        if (!isMounted) {
          return;
        }

        setSettings(value);
        setIsLoaded(true);
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        setIsLoaded(true);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const updateSettings = useCallback(async (patch: Partial<TranscriptionSettings>) => {
    const next = await patchTranscriptionSettings(patch);
    setSettings(next);
    return next;
  }, []);

  return {
    settings,
    isLoaded,
    updateSettings,
  };
}
