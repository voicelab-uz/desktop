import { useTranslation } from "react-i18next";
import { ChoiceGrid, StepFrame } from "./ui";
import { USE_CASE_OPTIONS } from "./useCases";
import { useSettingsStore } from "../../stores/settingsStore";

export default function TypingPlacesStep() {
  const { t } = useTranslation();
  const useCases = useSettingsStore((state) => state.onboardingUseCases);
  const setUseCases = useSettingsStore((state) => state.setOnboardingUseCases);

  return (
    <StepFrame
      title={t("desktop.onboarding.typingPlaces.title")}
      description={t("desktop.onboarding.typingPlaces.description")}
      width="lg"
    >
      <ChoiceGrid
        multi
        columns={4}
        compact
        value={useCases}
        onChange={(next) => setUseCases(next as string[])}
        options={USE_CASE_OPTIONS.map((option) => ({
          id: option.id,
          icon: option.icon,
          label: t(`desktop.onboarding.typingPlaces.options.${option.id}`),
        }))}
      />
    </StepFrame>
  );
}
