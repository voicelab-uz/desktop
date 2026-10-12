import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun, Wand2 } from "lucide-react";
import { Accent, OnbButton, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

interface PersonalizeIntroStepProps {
  onContinue: () => void;
  onLater: () => void;
}

const THEMES = [
  { value: "light", icon: Sun, key: "light" },
  { value: "dark", icon: Moon, key: "dark" },
  { value: "auto", icon: Monitor, key: "system" },
] as const;

export default function PersonalizeIntroStep({ onContinue, onLater }: PersonalizeIntroStepProps) {
  const { t } = useTranslation();
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);

  return (
    <StepFrame
      title={
        <>
          {t("desktop.onboarding.personalizeIntro.titlePrefix")}{" "}
          <Accent>{t("desktop.onboarding.personalizeIntro.titleAccent")}</Accent>{" "}
          {t("desktop.onboarding.personalizeIntro.titleSuffix")}
        </>
      }
      description={t("desktop.onboarding.personalizeIntro.description")}
      width="md"
    >
      <div className="flex h-24 w-24 items-center justify-center rounded-full border border-[var(--onb-card-border)] bg-[var(--onb-panel)]">
        <Wand2 className="h-10 w-10 text-[var(--onb-ink)]" strokeWidth={1.4} />
      </div>

      <section className="mt-7 w-full max-w-sm" aria-labelledby="onboarding-appearance">
        <h3 id="onboarding-appearance" className="mb-2.5 text-sm font-medium">
          {t("desktop.onboarding.personalizeIntro.appearance")}
        </h3>
        <div
          className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--onb-card-border)] bg-[var(--onb-card)] p-1"
          role="radiogroup"
        >
          {THEMES.map((option) => {
            const Icon = option.icon;
            const selected = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(option.value)}
                className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] ${
                  selected
                    ? "bg-[var(--onb-ink)] text-[var(--onb-bg)] shadow-sm"
                    : "text-[var(--onb-ink-muted)] hover:text-[var(--onb-ink)]"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={1.7} />
                {t(`desktop.onboarding.personalizeIntro.${option.key}`)}
              </button>
            );
          })}
        </div>
      </section>

      <div className="mt-8 flex items-center gap-3">
        <OnbButton variant="ghost" onClick={onLater}>
          {t("desktop.onboarding.personalizeIntro.later")}
        </OnbButton>
        <OnbButton
          size="lg"
          className="min-w-40"
          onClick={onContinue}
          autoFocus
          data-testid="onboarding-primary"
        >
          {t("common.continue")}
        </OnbButton>
      </div>
    </StepFrame>
  );
}
