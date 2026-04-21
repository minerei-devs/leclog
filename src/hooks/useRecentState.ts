import { useCallback, useEffect, useState } from "react";
import {
  defaultRecentState,
  getRecentState,
  patchRecentState,
} from "../lib/store";
import type { RecentState } from "../types/session";

export function useRecentState() {
  const [recentState, setRecentState] = useState<RecentState>(defaultRecentState);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void getRecentState()
      .then((value) => {
        if (!isMounted) {
          return;
        }

        setRecentState(value);
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

  const updateRecentState = useCallback(async (patch: Partial<RecentState>) => {
    const next = await patchRecentState(patch);
    setRecentState(next);
    return next;
  }, []);

  return {
    recentState,
    isLoaded,
    updateRecentState,
  };
}
