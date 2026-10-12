import { useTranslation } from "react-i18next";
import { Check, Cloud, History, ShieldCheck } from "lucide-react";
import AuthenticationStep from "../AuthenticationStep";
import { Card, StepFrame } from "./ui";

interface SignInStepProps {
  isSignedIn: boolean;
}

export default function SignInStep({ isSignedIn }: SignInStepProps) {
  const { t } = useTranslation();
  const benefits = [
    { icon: Cloud, text: t("desktop.onboarding.signin.benefitCloud") },
    { icon: History, text: t("desktop.onboarding.signin.benefitHistory") },
    { icon: ShieldCheck, text: t("desktop.onboarding.signin.benefitSecurity") },
  ];

  return (
    <StepFrame
      title={
        isSignedIn ? t("desktop.onboarding.signin.connected") : t("desktop.onboarding.signin.title")
      }
      description={
        isSignedIn
          ? t("desktop.onboarding.signin.connectedDescription")
          : t("desktop.onboarding.signin.description")
      }
      width="md"
    >
      <Card className="relative max-w-sm px-7 py-7">
        {isSignedIn ? (
          <div className="flex flex-col items-center text-center" role="status">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--onb-success)] text-white animate-[onboarding-sticker-pop_500ms_cubic-bezier(0.34,1.56,0.64,1)_both]">
              <Check className="h-8 w-8" strokeWidth={2.5} />
            </span>
            <p className="mt-4 text-sm text-[var(--onb-ink-muted)]">
              {t("desktop.onboarding.signin.continuing")}
            </p>
          </div>
        ) : (
          <AuthenticationStep onAuthComplete={() => {}} />
        )}
      </Card>

      <ul className="mt-5 grid w-full max-w-md grid-cols-3 gap-2.5">
        {benefits.map((benefit) => {
          const Icon = benefit.icon;
          return (
            <li
              key={benefit.text}
              className="flex flex-col items-center gap-2 rounded-xl border border-[var(--onb-card-border)] bg-[var(--onb-card)]/70 px-3 py-3 text-center"
            >
              <Icon className="h-4 w-4 text-[var(--onb-accent)]" strokeWidth={1.8} />
              <span className="text-xs leading-4 text-[var(--onb-ink-muted)]">{benefit.text}</span>
            </li>
          );
        })}
      </ul>
    </StepFrame>
  );
}
