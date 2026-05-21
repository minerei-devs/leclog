import { useCallback, useEffect, useState } from "react";
import { getProcessingSettings, patchProcessingSettings } from "@/lib/tauri";
import type { ProcessingSettings } from "@/types/session";

const fallbackProcessingSettings: ProcessingSettings = {
  qualityPreset: "balanced",
  preferredModelId: null,
  language: "auto",
  promptTerms: "",
  chunkDurationMinutes: 10,
  chunkOverlapSeconds: 20,
  whisperThreads: null,
  maxParallelChunks: 1,
  liveRefreshIntervalSeconds: 20,
};

export function useProcessingSettings() {
  const [settings, setSettings] = useState<ProcessingSettings>(fallbackProcessingSettings);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void getProcessingSettings()
      .then((result) => {
        if (isMounted) {
          setSettings(result);
          setError(null);
        }
      })
      .catch((reason) => {
        if (isMounted) {
          setError(reason instanceof Error ? reason.message : "Failed to load processing settings.");
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoaded(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const updateSettings = useCallback(async (patch: Partial<ProcessingSettings>) => {
    const nextSettings = await patchProcessingSettings(patch);
    setSettings(nextSettings);
    setError(null);
    return nextSettings;
  }, []);

  return {
    settings,
    isLoaded,
    error,
    updateSettings,
  };
}

export { fallbackProcessingSettings };
