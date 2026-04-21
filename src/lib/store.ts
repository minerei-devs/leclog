import { load } from "@tauri-apps/plugin-store";
import type { RecentState } from "../types/session";

const storePromise = load("settings.json", {
  autoSave: 200,
  defaults: {},
});

const defaultRecentState: RecentState = {
  activeSessionId: null,
  draftTitle: "",
  lastViewedSessionId: null,
};

export async function getRecentState(): Promise<RecentState> {
  const store = await storePromise;

  const activeSessionId = (await store.get<string>("activeSessionId")) ?? null;
  const draftTitle = (await store.get<string>("draftTitle")) ?? "";
  const lastViewedSessionId =
    (await store.get<string>("lastViewedSessionId")) ?? null;

  return {
    activeSessionId,
    draftTitle,
    lastViewedSessionId,
  };
}

export async function patchRecentState(
  patch: Partial<RecentState>,
): Promise<RecentState> {
  const store = await storePromise;
  const current = await getRecentState();
  const next = {
    ...current,
    ...patch,
  };

  const entries = Object.entries(next) as Array<[keyof RecentState, string | null]>;
  for (const [key, value] of entries) {
    if (value === null || value === "") {
      await store.delete(key);
      continue;
    }

    await store.set(key, value);
  }

  await store.save();
  return {
    ...defaultRecentState,
    ...next,
  };
}

export { defaultRecentState };
