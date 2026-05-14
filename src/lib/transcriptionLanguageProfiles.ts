import type { ProcessingQualityPreset, ProcessingSettings } from "@/types/session";

export type TranscriptionLanguageProfileId =
  | "auto"
  | "ja"
  | "en"
  | "zh"
  | "ko"
  | "custom";

export interface TranscriptionLanguageProfile {
  id: Exclude<TranscriptionLanguageProfileId, "custom">;
  label: string;
  language: string;
  promptTerms: string;
  description: string;
}

export const transcriptionLanguageProfiles: TranscriptionLanguageProfile[] = [
  {
    id: "auto",
    label: "Auto detect",
    language: "auto",
    promptTerms: "",
    description: "Let Whisper infer the spoken language.",
  },
  {
    id: "ja",
    label: "Japanese",
    language: "ja",
    promptTerms:
      "これは大学の講義の書き起こしです。自然な日本語の句読点（、。）を補って出力してください。授業、講義、先生、学生、発表。",
    description: "Japanese lectures with academic vocabulary.",
  },
  {
    id: "en",
    label: "English",
    language: "en",
    promptTerms: "lecture professor student presentation question discussion",
    description: "English lectures and seminars.",
  },
  {
    id: "zh",
    label: "Chinese",
    language: "zh",
    promptTerms: "课程 讲座 老师 学生 发表 问题 讨论",
    description: "Chinese lectures and classroom recordings.",
  },
  {
    id: "ko",
    label: "Korean",
    language: "ko",
    promptTerms: "강의 수업 교수 학생 발표 질문 토론",
    description: "Korean lectures and seminars.",
  },
];

const defaultModelPriorityByPreset: Record<ProcessingQualityPreset, string[]> = {
  fast: ["ggml-base.bin", "ggml-tiny.bin", "ggml-base.en.bin", "ggml-tiny.en.bin"],
  balanced: ["ggml-small.bin", "ggml-base.bin", "ggml-small.en.bin", "ggml-base.en.bin"],
  accurate: [
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-small.bin",
    "ggml-base.bin",
  ],
  custom: [],
};

export function getLanguageProfile(language: string | null | undefined) {
  const normalized = normalizeLanguageCode(language);
  return transcriptionLanguageProfiles.find((profile) => profile.language === normalized) ?? null;
}

export function getLanguageProfileId(language: string | null | undefined): TranscriptionLanguageProfileId {
  return getLanguageProfile(language)?.id ?? "custom";
}

export function getLanguageLabel(language: string | null | undefined) {
  const normalized = normalizeLanguageCode(language);
  return getLanguageProfile(normalized)?.label ?? normalized;
}

export function normalizeLanguageCode(language: string | null | undefined) {
  const normalized = language?.trim().toLowerCase().replace("_", "-");
  if (!normalized) {
    return "auto";
  }

  const aliases: Record<string, string> = {
    automatic: "auto",
    detect: "auto",
    english: "en",
    japanese: "ja",
    jp: "ja",
    chinese: "zh",
    cn: "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    korean: "ko",
    kr: "ko",
  };
  return aliases[normalized] ?? normalized;
}

export function isEnglishOnlyModel(modelId: string | null | undefined) {
  return Boolean(modelId?.includes(".en."));
}

export function languageNeedsMultilingualModel(language: string | null | undefined) {
  const normalized = normalizeLanguageCode(language).toLowerCase();
  return normalized !== "auto" && normalized !== "en";
}

export function resolveLikelyTranscriptionModelId(
  settings: Pick<ProcessingSettings, "preferredModelId" | "qualityPreset">,
  installedModelIds: string[],
) {
  const installed = new Set(installedModelIds);
  if (settings.preferredModelId && installed.has(settings.preferredModelId)) {
    return settings.preferredModelId;
  }

  const priority = defaultModelPriorityByPreset[settings.qualityPreset];
  return priority.find((modelId) => installed.has(modelId)) ?? null;
}
