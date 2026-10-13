import { useEffect } from "react";

import {
  flushPendingOnboardingProfile,
  onboardingProfileFromState,
  pullOnboardingProfileOnce,
  syncOnboardingProfile,
} from "../helpers/onboardingProfile";
import { useSettingsStore } from "../stores/settingsStore";

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Keeps the account's onboarding profile current after onboarding has
 * finished: retries a queued save, restores the saved answers once per
 * account on a fresh installation, and pushes later changes made in settings
 * (dictation language, writing style, appearance, interface language).
 */
export function useOnboardingProfileSync({
  enabled,
  userId,
}: {
  enabled: boolean;
  userId: string | null | undefined;
}) {
  useEffect(() => {
    if (!enabled || !userId) return undefined;
    let disposed = false;
    let timer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    let last = "";

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void syncOnboardingProfile();
      }, SYNC_DEBOUNCE_MS);
    };

    void (async () => {
      await pullOnboardingProfileOnce(userId);
      await flushPendingOnboardingProfile();
      if (disposed) return;
      last = JSON.stringify(onboardingProfileFromState(useSettingsStore.getState()));
      unsubscribe = useSettingsStore.subscribe((state) => {
        const next = JSON.stringify(onboardingProfileFromState(state));
        if (next === last) return;
        last = next;
        schedule();
      });
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [enabled, userId]);
}
