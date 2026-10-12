import { useTranslation } from "react-i18next";
import { AppWindow, Keyboard, PartyPopper, TextCursorInput } from "lucide-react";
import AuthenticationStep from "../AuthenticationStep";
import { Card, Celebration, ShortcutSentence, StepFrame } from "./ui";
import { shortcutSentence, type ActivationMode } from "./shortcutCopy";

interface DoneStepProps {
  isSignedIn: boolean;
  hotkey: string;
  activationMode: ActivationMode;
}

export default function DoneStep({ isSignedIn, hotkey, activationMode }: DoneStepProps) {
  const { t } = useTranslation();

  if (!isSignedIn) {
    return (
      <StepFrame
        title={t("desktop.onboarding.finish.signInTitle")}
        description={t("desktop.onboarding.finish.signInRequired")}
        width="md"
      >
        <Card className="max-w-md px-8 py-8">
          <AuthenticationStep onAuthComplete={() => {}} />
        </Card>
      </StepFrame>
    );
  }

  const steps = [
    { icon: AppWindow, text: t("desktop.onboarding.finish.step1") },
    { icon: TextCursorInput, text: t("desktop.onboarding.finish.step2") },
    { icon: Keyboard, text: null },
  ];

  return (
    <StepFrame
      title={t("desktop.onboarding.finish.title")}
      description={t("desktop.onboarding.finish.subtitle")}
      width="md"
    >
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-[var(--onb-card-border)] bg-[var(--onb-panel)] animate-[onboarding-sticker-pop_600ms_cubic-bezier(0.34,1.56,0.64,1)_both]">
        <Celebration />
        <PartyPopper className="h-9 w-9 text-[var(--onb-ink)]" strokeWidth={1.4} />
      </div>

      <ol className="onboarding-stagger mt-6 w-full max-w-md space-y-2.5">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <Card key={index} className="flex items-center gap-4 px-4 py-3 text-left">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--onb-ink)] text-sm font-semibold text-[var(--onb-bg)]">
                {index + 1}
              </span>
              <span className="flex-1 text-sm font-medium leading-6">
                {step.text ?? (
                  <ShortcutSentence
                    text={shortcutSentence(t, "desktop.onboarding.finish.step3", activationMode)}
                    hotkey={hotkey}
                  />
                )}
              </span>
              <Icon className="h-4 w-4 shrink-0 text-[var(--onb-ink-muted)]" strokeWidth={1.7} />
            </Card>
          );
        })}
      </ol>

      <p className="mt-5 max-w-md text-xs leading-5 text-[var(--onb-ink-muted)]">
        {t("desktop.onboarding.finish.note")}
      </p>
    </StepFrame>
  );
}
