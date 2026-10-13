import { useSettingsStore } from "../stores/settingsStore";
import type { DesktopOnboardingInput, DesktopOnboardingProfile } from "../types/electron";

/**
 * Onboarding answers belong to the VoiceLab account, not to this installation.
 * This module is the single place that turns local settings into the server
 * profile and back:
 *
 * - `syncOnboardingProfile` sends the current answers (once onboarding
 *   finishes, and again whenever one of them changes later).
 * - `applyOnboardingProfile` prefills a new installation from the saved
 *   profile without overwriting answers already given on this machine.
 *
 * A failed save is remembered and retried the next time the app starts signed
 * in, so onboarding never blocks on the network.
 */

const PENDING_KEY = "voicelab:onboarding-profile-pending";
const PULLED_KEY = "voicelab:onboarding-profile-pulled";

type SettingsState = ReturnType<typeof useSettingsStore.getState>;
type Theme = SettingsState["theme"];

function languageCode(value: string | null | undefined): string {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  return normalized.split("-")[0];
}

function writingStyle(state: SettingsState): string {
  return (
    state.writingStyleOther ||
    state.writingStyleWork ||
    state.writingStylePersonal ||
    state.writingStyleEmail ||
    ""
  );
}

export function onboardingProfileFromState(state: SettingsState): DesktopOnboardingInput {
  return {
    role: state.onboardingRole || "",
    useCases: Array.isArray(state.onboardingUseCases) ? state.onboardingUseCases : [],
    dictationLanguage: languageCode(state.preferredLanguage),
    writingStyle: writingStyle(state),
    uiLanguage: (state.uiLanguage || "").toLowerCase(),
    theme: state.theme || "",
  };
}

export function buildOnboardingProfile(): DesktopOnboardingInput {
  return onboardingProfileFromState(useSettingsStore.getState());
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in previews; the next sync simply retries.
  }
}

export function hasPendingOnboardingProfile(): boolean {
  return readStorage(PENDING_KEY) !== null;
}

/**
 * Fills in answers the user has not given on this installation yet. Returns
 * the names of the fields that were applied so callers can log or test them.
 */
export function applyOnboardingProfile(profile: DesktopOnboardingProfile): string[] {
  const state = useSettingsStore.getState();
  const applied: string[] = [];
  if (!state.onboardingRole && profile.role) {
    state.setOnboardingRole(profile.role);
    applied.push("role");
  }
  if ((state.onboardingUseCases?.length ?? 0) === 0 && profile.useCases.length > 0) {
    state.setOnboardingUseCases(profile.useCases);
    applied.push("useCases");
  }
  if (languageCode(state.preferredLanguage) === "auto" && profile.dictationLanguage !== "auto") {
    state.setPreferredLanguage(profile.dictationLanguage);
    applied.push("dictationLanguage");
  }
  if (!writingStyle(state) && profile.writingStyle) {
    state.setWritingStylePersonal(profile.writingStyle);
    state.setWritingStyleWork(profile.writingStyle);
    state.setWritingStyleEmail(profile.writingStyle);
    state.setWritingStyleOther(profile.writingStyle);
    applied.push("writingStyle");
  }
  if (profile.theme && readStorage("theme") === null) {
    state.setTheme(profile.theme as Theme);
    applied.push("theme");
  }
  return applied;
}

/** Sends the current answers. Never throws; a failure is queued for retry. */
export async function syncOnboardingProfile(
  input: DesktopOnboardingInput = buildOnboardingProfile()
): Promise<boolean> {
  const save = window.electronAPI?.desktopOnboardingSave;
  if (!save) return false;
  try {
    const result = await save(input);
    if (result?.success) {
      writeStorage(PENDING_KEY, null);
      return true;
    }
    if (!result || !("retryable" in result) || result.retryable !== false) {
      writeStorage(PENDING_KEY, String(Date.now()));
    }
    return false;
  } catch {
    writeStorage(PENDING_KEY, String(Date.now()));
    return false;
  }
}

/** Retries a save that failed earlier, using the latest local answers. */
export async function flushPendingOnboardingProfile(): Promise<boolean> {
  if (!hasPendingOnboardingProfile()) return false;
  return syncOnboardingProfile();
}

/**
 * Pulls the saved profile once per account on this installation. A reinstall
 * that is still signed in skips onboarding, so this is what brings the
 * dictation language and writing style back.
 */
export async function pullOnboardingProfileOnce(userId: string): Promise<string[]> {
  if (!userId || readStorage(PULLED_KEY) === userId) return [];
  const get = window.electronAPI?.desktopOnboardingGet;
  if (!get) return [];
  try {
    const profile = await get();
    writeStorage(PULLED_KEY, userId);
    return profile ? applyOnboardingProfile(profile) : [];
  } catch {
    return [];
  }
}
