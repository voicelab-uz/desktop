import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { usePermissions } from "../hooks/usePermissions";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuth } from "../hooks/useAuth";
import { formatHotkeyLabel, getDefaultHotkey } from "../utils/hotkeys";
import { getPlatform } from "../utils/platform";
import wordmark from "../assets/voicelab.svg";
import {
  ONBOARDING_SECTIONS,
  ONBOARDING_STEP_KEY,
  ONBOARDING_STEPS,
  clearOnboardingProgress,
  readOnboardingStep,
  sectionIndexForStep,
  type OnboardingStep,
} from "../constants/onboarding";
import { applyOnboardingProfile, syncOnboardingProfile } from "../helpers/onboardingProfile";
import { OnbButton } from "./onboarding/ui";
import WelcomeStep from "./onboarding/WelcomeStep";
import SignInStep from "./onboarding/SignInStep";
import AboutYouStep from "./onboarding/AboutYouStep";
import TypingPlacesStep from "./onboarding/TypingPlacesStep";
import PermissionsStep from "./onboarding/PermissionsStep";
import MicTestStep from "./onboarding/MicTestStep";
import ShortcutStep from "./onboarding/ShortcutStep";
import LanguageStep from "./onboarding/LanguageStep";
import TryItIntroStep from "./onboarding/TryItIntroStep";
import TryItStep, { type DictationStats } from "./onboarding/TryItStep";
import TimeSavingsStep from "./onboarding/TimeSavingsStep";
import PersonalizeStep from "./onboarding/PersonalizeStep";
import DoneStep from "./onboarding/DoneStep";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

type IntroPhase = "blank-before" | "mark" | "blank-after" | "complete";

interface StepConfig {
  /** "always": Continue is enabled on arrival. "gated": the step reports readiness. */
  ready: "always" | "gated";
  /** Offer a Skip action while the step is not ready yet. */
  skippable?: boolean;
  /** The step draws its own call to action instead of the shared footer. */
  ownCta?: boolean;
}

const STEP_CONFIG: Record<OnboardingStep, StepConfig> = {
  welcome: { ready: "always", ownCta: true },
  signin: { ready: "gated" },
  "about-you": { ready: "always", skippable: true },
  "typing-places": { ready: "always", skippable: true },
  permissions: { ready: "gated" },
  "mic-test": { ready: "gated", skippable: true },
  shortcut: { ready: "gated" },
  language: { ready: "always" },
  "try-it-intro": { ready: "always", ownCta: true },
  "try-it-message": { ready: "gated", skippable: true },
  "try-it-email": { ready: "gated", skippable: true },
  "try-it-list": { ready: "gated", skippable: true },
  "time-savings": { ready: "always" },
  personalize: { ready: "always", ownCta: true },
  finish: { ready: "gated" },
};

const UI_LANGUAGES = [
  { value: "uz", label: "O‘zbekcha" },
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

const ONBOARDING_NAV_BUTTON_CLASS = "min-w-28";

function firstNameOf(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "TEXTAREA" ||
    target.tagName === "INPUT" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<OnboardingStep>(readOnboardingStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [introPhase, setIntroPhase] = useState<IntroPhase>("blank-before");
  const [stepReady, setStepReady] = useState(false);
  const [dictationStats, setDictationStats] = useState<DictationStats | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const dictationKey = useSettingsStore((state) => state.dictationKey);
  const setDictationKey = useSettingsStore((state) => state.setDictationKey);
  const activationMode = useSettingsStore((state) => state.activationMode);
  const uiLanguage = useSettingsStore((state) => state.uiLanguage);
  const setUiLanguage = useSettingsStore((state) => state.setUiLanguage);

  const platform = getPlatform();
  const needsTextInsertionPermission = platform === "darwin";
  const [hotkey, setHotkey] = useState(
    () => localStorage.getItem("hotkey") || dictationKey || getDefaultHotkey()
  );
  const hotkeyLabel = formatHotkeyLabel(hotkey);

  const permissions = usePermissions();
  const { registerHotkey, isRegistering } = useHotkeyRegistration();
  const { isSignedIn, user } = useAuth();

  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const sectionIndex = sectionIndexForStep(step);
  const isLastStep = stepIndex === ONBOARDING_STEPS.length - 1;
  const config = STEP_CONFIG[step];
  const progress = ((stepIndex + 1) / ONBOARDING_STEPS.length) * 100;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIntroPhase("complete");
      return undefined;
    }

    const timer = window.setTimeout(() => setIntroPhase("mark"), 500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (introPhase !== "blank-after") return undefined;

    const timer = window.setTimeout(() => setIntroPhase("complete"), 500);
    return () => window.clearTimeout(timer);
  }, [introPhase]);

  // Chromium pauses CSS animations in hidden or occluded windows, so the mark's
  // animationend may never fire. Never let the intro outlive its own duration.
  useEffect(() => {
    if (introPhase !== "mark") return undefined;

    const timer = window.setTimeout(() => setIntroPhase("blank-after"), 4200);
    return () => window.clearTimeout(timer);
  }, [introPhase]);

  const go = useCallback(
    (next: OnboardingStep) => {
      const nextIndex = ONBOARDING_STEPS.indexOf(next);
      setDirection(nextIndex >= stepIndex ? "forward" : "back");
      localStorage.setItem(ONBOARDING_STEP_KEY, next);
      setStepReady(false);
      setStep(next);
      contentRef.current?.scrollTo({ top: 0 });
    },
    [stepIndex]
  );

  const goNext = useCallback(() => {
    go(ONBOARDING_STEPS[Math.min(ONBOARDING_STEPS.length - 1, stepIndex + 1)]);
  }, [go, stepIndex]);

  const goBack = useCallback(() => {
    go(ONBOARDING_STEPS[Math.max(0, stepIndex - 1)]);
  }, [go, stepIndex]);

  const finish = useCallback(() => {
    if (!isSignedIn) return;
    const state = useSettingsStore.getState();
    state.setCloudTranscriptionForAllScopes({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
    });
    localStorage.setItem("transcriptionMode", "openwhispr");
    useSettingsStore.setState({ transcriptionMode: "openwhispr" });
    clearOnboardingProgress();
    // The answers are stored on the account so other installations can reuse
    // them. This never blocks finishing: a failed save is retried later.
    void syncOnboardingProfile();
    onComplete();
  }, [isSignedIn, onComplete]);

  // Signing in finishes the account step on its own. Answers saved from an
  // earlier installation prefill the next steps; local choices are kept.
  useEffect(() => {
    if (step !== "signin" || !isSignedIn) return undefined;
    let cancelled = false;
    void window.electronAPI
      ?.desktopOnboardingGet?.()
      .then((profile) => {
        if (!cancelled && profile) applyOnboardingProfile(profile);
      })
      .catch(() => {});
    const timer = window.setTimeout(goNext, 1100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [goNext, isSignedIn, step]);

  const handleHotkeyChange = useCallback(
    async (value: string) => {
      const registered = await registerHotkey(value);
      if (registered) {
        setHotkey(value);
        setDictationKey(value);
        localStorage.setItem("hotkey", value);
      }
      return registered;
    },
    [registerHotkey, setDictationKey]
  );

  const handleDictationComplete = useCallback((stats: DictationStats) => {
    setDictationStats((current) => current ?? stats);
  }, []);

  const canContinue =
    config.ready === "always" ||
    stepReady ||
    (step === "signin" && isSignedIn) ||
    (step === "finish" && isSignedIn);

  const primaryAction = isLastStep ? finish : goNext;
  const primaryLabel = useMemo(() => {
    if (step === "finish") return t("desktop.onboarding.nav.finish");
    return t("common.continue");
  }, [step, t]);

  // Enter advances whenever the shared footer is visible and the step is ready.
  useEffect(() => {
    if (config.ownCta) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || isTypingTarget(event.target)) return;
      if (!canContinue) return;
      event.preventDefault();
      primaryAction();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canContinue, config.ownCta, primaryAction]);

  const firstName = firstNameOf(user?.name) ?? firstNameOf(user?.email?.split("@")[0]);

  if (introPhase !== "complete") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        {introPhase === "mark" && (
          <img
            src={wordmark}
            alt="VoiceLab"
            className="h-11 w-auto max-w-56 dark:invert animate-[onboarding-mark-sequence_3800ms_both]"
            onAnimationEnd={() => setIntroPhase("blank-after")}
          />
        )}
      </div>
    );
  }

  const content = (() => {
    switch (step) {
      case "welcome":
        return <WelcomeStep onStart={goNext} />;
      case "signin":
        return <SignInStep isSignedIn={isSignedIn} />;
      case "about-you":
        return <AboutYouStep />;
      case "typing-places":
        return <TypingPlacesStep />;
      case "permissions":
        return (
          <PermissionsStep
            permissions={permissions}
            needsTextInsertionPermission={needsTextInsertionPermission}
            onReadyChange={setStepReady}
          />
        );
      case "mic-test":
        return <MicTestStep onReadyChange={setStepReady} />;
      case "shortcut":
        return (
          <ShortcutStep
            hotkey={hotkey}
            activationMode={activationMode}
            isRegistering={isRegistering}
            onHotkeyChange={handleHotkeyChange}
            onReadyChange={setStepReady}
            onConfirm={goNext}
          />
        );
      case "language":
        return <LanguageStep />;
      case "try-it-intro":
        return <TryItIntroStep hotkey={hotkey} activationMode={activationMode} onStart={goNext} />;
      case "try-it-message":
      case "try-it-email":
      case "try-it-list":
        return (
          <TryItStep
            key={step}
            variant={
              step === "try-it-message" ? "message" : step === "try-it-email" ? "email" : "list"
            }
            hotkey={hotkey}
            activationMode={activationMode}
            firstName={firstName}
            onComplete={handleDictationComplete}
            onReadyChange={setStepReady}
          />
        );
      case "time-savings":
        return <TimeSavingsStep stats={dictationStats} />;
      case "personalize":
        return <PersonalizeStep onContinue={goNext} onLater={() => go("finish")} />;
      case "finish":
        return <DoneStep isSignedIn={isSignedIn} hotkey={hotkey} activationMode={activationMode} />;
      default:
        return null;
    }
  })();

  return (
    <div className="onboarding-root flex min-h-screen items-center justify-center bg-muted/35 px-5 py-5 text-foreground animate-[onboarding-content-in_800ms_cubic-bezier(0.22,1,0.36,1)_both]">
      <section className="relative flex h-[min(42rem,calc(100vh-2.5rem))] w-[66rem] max-w-full overflow-hidden rounded-xl border border-border bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.22)]">
        <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/40 px-5 py-6">
          <img src={wordmark} alt="VoiceLab" className="h-5 w-auto self-start dark:invert" />
          <nav className="mt-8 flex-1" aria-label={t("desktop.onboarding.nav.progress")}>
            <ol className="space-y-1">
              {ONBOARDING_SECTIONS.map((section, index) => {
                const state =
                  index < sectionIndex ? "done" : index === sectionIndex ? "active" : "upcoming";
                return (
                  <li
                    key={section.id}
                    aria-current={state === "active" ? "step" : undefined}
                    className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors duration-200 ${
                      state === "active"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : state === "done"
                          ? "text-foreground/70"
                          : "text-muted-foreground"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold transition-colors duration-200 ${
                        state === "done"
                          ? "bg-primary text-primary-foreground"
                          : state === "active"
                            ? "border-2 border-primary text-foreground"
                            : "border border-border text-muted-foreground"
                      }`}
                    >
                      {state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
                    </span>
                    {t(`desktop.onboarding.sections.${section.id}`)}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="space-y-3">
            <Select value={uiLanguage} onValueChange={setUiLanguage}>
              <SelectTrigger
                className="h-8 w-full rounded-lg text-xs"
                aria-label={t("desktop.onboarding.nav.uiLanguage")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UI_LANGUAGES.map((language) => (
                  <SelectItem key={language.value} value={language.value}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs leading-4 text-muted-foreground">
              {t("desktop.onboarding.nav.stepCount", {
                current: stepIndex + 1,
                total: ONBOARDING_STEPS.length,
              })}
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="h-0.5 w-full shrink-0 bg-border/60" aria-hidden="true">
            <div
              className="h-full bg-primary transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ width: `${progress}%` }}
            />
          </div>

          <main className="min-h-0 flex-1 overflow-hidden">
            <div
              ref={contentRef}
              key={step}
              data-direction={direction}
              className="onboarding-step-enter flex h-full flex-col items-center justify-center px-8 py-6"
            >
              {content}
            </div>
          </main>

          <footer className="flex h-16 shrink-0 items-center justify-between border-t border-border px-6">
            <div>
              {stepIndex > 0 && (
                <OnbButton variant="ghost" className={ONBOARDING_NAV_BUTTON_CLASS} onClick={goBack}>
                  <ArrowLeft className="h-4 w-4" strokeWidth={2} />
                  {t("common.back")}
                </OnbButton>
              )}
            </div>
            {!config.ownCta && (
              <div className="flex items-center gap-2">
                {config.skippable && !canContinue && (
                  <OnbButton
                    variant="ghost"
                    className={ONBOARDING_NAV_BUTTON_CLASS}
                    onClick={goNext}
                    data-testid="onboarding-skip"
                  >
                    {t("common.skip")}
                  </OnbButton>
                )}
                <OnbButton
                  size="lg"
                  className={ONBOARDING_NAV_BUTTON_CLASS}
                  disabled={!canContinue}
                  onClick={primaryAction}
                  data-testid="onboarding-primary"
                >
                  {primaryLabel}
                </OnbButton>
              </div>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}
