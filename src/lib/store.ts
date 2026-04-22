import { load } from "@tauri-apps/plugin-store";
import type { CaptureSource, RecentState, TranscriptionSettings } from "../types/session";

function buildDefaultDraftTitle(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

const storePromise = load("settings.json", {
  autoSave: 200,
  defaults: {},
});

const defaultRecentState: RecentState = {
  activeSessionId: null,
  draftTitle: buildDefaultDraftTitle(),
  draftCaptureSource: "microphone",
  lastViewedSessionId: null,
};

const defaultTranscriptionSettings: TranscriptionSettings = {
  preferredModelId: null,
  preferredLanguage: "ja",
  promptTerms:
    "これは大学の講義の書き起こしです。自然な日本語の句読点（、。）を補って出力してください。授業、講義、先生、学生、発表。",
};

export async function getRecentState(): Promise<RecentState> {
  const store = await storePromise;

  const activeSessionId = (await store.get<string>("activeSessionId")) ?? null;
  const draftTitle =
    (await store.get<string>("draftTitle")) ?? defaultRecentState.draftTitle;
  const draftCaptureSource =
    ((await store.get<CaptureSource>("draftCaptureSource")) as CaptureSource | null) ??
    "microphone";
  const lastViewedSessionId =
    (await store.get<string>("lastViewedSessionId")) ?? null;

  return {
    activeSessionId,
    draftTitle,
    draftCaptureSource,
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

export async function getTranscriptionSettings(): Promise<TranscriptionSettings> {
  const store = await storePromise;

  return {
    preferredModelId: (await store.get<string>("preferredModelId")) ?? null,
    preferredLanguage:
      (await store.get<string>("preferredLanguage")) ??
      defaultTranscriptionSettings.preferredLanguage,
    promptTerms:
      (await store.get<string>("promptTerms")) ?? defaultTranscriptionSettings.promptTerms,
  };
}

export async function patchTranscriptionSettings(
  patch: Partial<TranscriptionSettings>,
): Promise<TranscriptionSettings> {
  const store = await storePromise;
  const current = await getTranscriptionSettings();
  const next = {
    ...current,
    ...patch,
  };

  const entries = Object.entries(next) as Array<[keyof TranscriptionSettings, string | null]>;
  for (const [key, value] of entries) {
    if (value === null || value === "") {
      await store.delete(key);
      continue;
    }

    await store.set(key, value);
  }

  await store.save();
  return {
    ...defaultTranscriptionSettings,
    ...next,
  };
}

export { defaultRecentState, defaultTranscriptionSettings };
export { buildDefaultDraftTitle };
