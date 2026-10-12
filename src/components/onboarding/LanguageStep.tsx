import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoiceGrid, StepFrame } from "./ui";
import { getDesktopLanguageOptions } from "../../config/desktopLanguageOptions";
import { useSettingsStore } from "../../stores/settingsStore";

// The VoiceLab desktop STT contract accepts these languages today.
const CLOUD_LANGUAGES = ["uz", "ru", "en"] as const;

export default function LanguageStep() {
  const { t } = useTranslation();
  const preferredLanguage = useSettingsStore((state) => state.preferredLanguage);
  const setPreferredLanguage = useSettingsStore((state) => state.setPreferredLanguage);
  const uiLanguage = useSettingsStore((state) => state.uiLanguage);
  const [options] = useState(() =>
    getDesktopLanguageOptions("voicelab", {
      supportedLanguages: CLOUD_LANGUAGES,
      autoDetectionSupported: true,
    }).filter((option) => !option.disabled)
  );

  // First run keeps "auto"; suggest the interface language so the choice is visible.
  useEffect(() => {
    if (preferredLanguage !== "auto") return;
    if ((CLOUD_LANGUAGES as readonly string[]).includes(uiLanguage)) {
      setPreferredLanguage(uiLanguage);
    }
    // Only on mount: later changes are the user's explicit decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <StepFrame
      title={t("desktop.onboarding.dictationLanguage.title")}
      description={t("desktop.onboarding.dictationLanguage.description")}
      width="md"
    >
      <ChoiceGrid
        columns={2}
        value={preferredLanguage}
        onChange={(next) => setPreferredLanguage(next as string)}
        className="max-w-xl"
        options={options.map((option) => ({
          id: option.value,
          emoji: option.flag,
          label:
            option.value === "auto"
              ? t("desktop.onboarding.dictationLanguage.auto")
              : (option.localizedName ?? option.label),
          description:
            option.value === "auto"
              ? t("desktop.onboarding.dictationLanguage.autoDescription")
              : option.label,
        }))}
      />
      <p className="mt-5 text-xs leading-5 text-[var(--onb-ink-muted)]">
        {t("desktop.onboarding.dictationLanguage.changeLater")}
      </p>
    </StepFrame>
  );
}
