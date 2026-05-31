import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

export const unsupportedUpdaterPlatformMessage =
  "Automatic updates are available for macOS and Windows release builds only.";

function isMacPlatform() {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();

  return platform.includes("mac") || userAgent.includes("macintosh") || userAgent.includes("mac os x");
}

function isWindowsPlatform() {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();

  return platform.includes("win") || userAgent.includes("windows");
}

export function isUpdaterPlatformSupported() {
  return isMacPlatform() || isWindowsPlatform();
}

export async function checkForLeclogUpdate(timeout: number): Promise<Update | null> {
  if (!isUpdaterPlatformSupported()) {
    return null;
  }

  return check({ timeout });
}
