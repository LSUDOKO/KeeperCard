// One persistent, headed Chromium profile for all recordings. Sessions signed into here
// (Privy for the KeeperCard dashboard, KeeperHub) survive between runs.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE = path.join(here, "..", "tmp", "profile");
export const CHROME = path.join(os.homedir(), ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");
export const VIEWPORT = { width: 1920, height: 1080 };

export async function openBrowser({ record = null } = {}) {
  return chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    args: ["--window-size=1920,1120", "--hide-scrollbars", "--disable-infobars"],
    ignoreDefaultArgs: ["--enable-automation"],
    ...(record ? { recordVideo: { dir: record, size: VIEWPORT } } : {}),
  });
}
