import { useCallback, useEffect, useState } from "react";
import {
  defaultAppSettings,
  getAppSettings,
  patchAppSettings,
} from "@/lib/store";
import type { AppSettings } from "@/types/session";

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void getAppSettings()
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

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await patchAppSettings(patch);
    setSettings(next);
    return next;
  }, []);

  return {
    settings,
    isLoaded,
    updateSettings,
  };
}
