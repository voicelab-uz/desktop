import { useTranslation } from "react-i18next";
import { Keycap, OnbButton, ShortcutSentence, StepFrame } from "./ui";
import { shortcutSentence, type ActivationMode } from "./shortcutCopy";

interface TryItIntroStepProps {
  hotkey: string;
  activationMode: ActivationMode;
  onStart: () => void;
}

export default function TryItIntroStep({ hotkey, activationMode, onStart }: TryItIntroStepProps) {
  const { t } = useTranslation();

  return (
    <StepFrame
      title={
        <ShortcutSentence
          text={shortcutSentence(t, "desktop.onboarding.tryItIntro.title", activationMode)}
          hotkey={hotkey}
        />
      }
      description={t(
        `desktop.onboarding.tryItIntro.subtitle${activationMode === "push" ? "Hold" : "Tap"}`
      )}
      width="md"
    >
      <div className="relative flex h-40 w-40 items-center justify-center rounded-full border border-[var(--onb-card-border)] bg-[var(--onb-panel)]">
        <span
          className="absolute inset-0 rounded-full border border-[var(--onb-accent)] opacity-40 animate-[onboarding-key-glow_2200ms_ease-in-out_infinite]"
          aria-hidden="true"
        />
        <Keycap hotkey={hotkey} size="xl" demo />
      </div>

      <OnbButton
        size="lg"
        className="mt-8 min-w-40"
        onClick={onStart}
        autoFocus
        data-testid="onboarding-primary"
      >
        {t("desktop.onboarding.tryItIntro.cta")}
      </OnbButton>
    </StepFrame>
  );
}
