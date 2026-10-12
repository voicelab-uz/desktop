import { useTranslation } from "react-i18next";
import { ArrowRight, FileText, Mic } from "lucide-react";
import wordmark from "../../assets/voicelab.svg";
import { Accent, OnbButton, StepFrame } from "./ui";

interface WelcomeStepProps {
  onStart: () => void;
}

export default function WelcomeStep({ onStart }: WelcomeStepProps) {
  const { t } = useTranslation();
  const stages = [
    { icon: Mic, label: t("desktop.onboarding.welcome.speak"), delay: "0ms" },
    { icon: null, label: t("desktop.onboarding.welcome.voicelab"), delay: "900ms" },
    { icon: FileText, label: t("desktop.onboarding.welcome.text"), delay: "1800ms" },
  ];

  return (
    <StepFrame
      title={
        <>
          {t("desktop.onboarding.welcome.titlePrefix")}{" "}
          <Accent>{t("desktop.onboarding.welcome.titleAccent")}</Accent>
          {t("desktop.onboarding.welcome.titleSuffix")}
        </>
      }
      description={t("desktop.onboarding.welcome.description")}
    >
      <img src={wordmark} alt="VoiceLab" className="order-first mb-7 h-7 w-auto dark:invert" />

      <div
        className="grid grid-cols-[auto_auto_auto_auto_auto] items-center gap-4"
        role="img"
        aria-label={t("desktop.onboarding.welcome.description")}
      >
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <div key={stage.label} className="contents">
              {index > 0 && (
                <ArrowRight
                  className="h-5 w-5 text-[var(--onb-ink-muted)] opacity-60"
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              )}
              <div className="flex flex-col items-center gap-3">
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-xl border shadow-[var(--onb-key-shadow)] ${
                    Icon
                      ? "border-[var(--onb-key-border)] bg-[var(--onb-key)] text-[var(--onb-ink)]"
                      : "border-[var(--onb-ink)] bg-[var(--onb-ink)]"
                  }`}
                  style={{ animationDelay: stage.delay }}
                >
                  {Icon ? (
                    <Icon className="h-6 w-6" strokeWidth={1.6} />
                  ) : (
                    <img src={wordmark} alt="" className="h-4 w-auto invert dark:invert-0" />
                  )}
                </span>
                <span className="text-sm font-medium text-[var(--onb-ink-muted)]">
                  {stage.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <OnbButton
        size="lg"
        className="mt-9 min-w-40"
        onClick={onStart}
        autoFocus
        data-testid="onboarding-primary"
      >
        {t("desktop.onboarding.nav.startSetup")}
      </OnbButton>
    </StepFrame>
  );
}
