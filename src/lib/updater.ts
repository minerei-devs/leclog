import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

export const unsupportedUpdaterPlatformMessage =
  "Automatic updates are currently available for macOS builds only.";

function isMacPlatform() {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();

  return platform.includes("mac") || userAgent.includes("macintosh") || userAgent.includes("mac os x");
}

export function isUpdaterPlatformSupported() {
  return isMacPlatform();
}

export async function checkForLeclogUpdate(timeout: number): Promise<Update | null> {
  if (!isUpdaterPlatformSupported()) {
    return null;
  }

  return check({ timeout });
}
