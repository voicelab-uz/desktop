import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Accent, OnbButton, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

type StyleId = "casual" | "formal" | "excited";
const STYLES: StyleId[] = ["casual", "formal", "excited"];

const THEMES = [
  { value: "light", icon: Sun, key: "light" },
  { value: "dark", icon: Moon, key: "dark" },
  { value: "auto", icon: Monitor, key: "system" },
] as const;

interface PersonalizeStepProps {
  onContinue: () => void;
  onLater: () => void;
}

/**
 * Highlights the parts of the sample that the style changes: `[text]` marks
 * capitalisation or wording, `{text}` marks punctuation.
 */
function renderSample(sample: string) {
  const tokens = sample.split(/(\[[^\]]+\]|\{[^}]+\})/g).filter(Boolean);
  return tokens.map((token, index) => {
    if (token.startsWith("[")) {
      return (
        <span
          key={index}
          className="rounded-sm bg-[var(--onb-accent-soft)] px-0.5 text-[var(--onb-accent)]"
        >
          {token.slice(1, -1)}
        </span>
      );
    }
    if (token.startsWith("{")) {
      return (
        <span
          key={index}
          className="rounded-sm bg-[#4b6fff]/15 px-0.5 font-semibold text-[#4b6fff]"
        >
          {token.slice(1, -1)}
        </span>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

/** One writing style for every kind of text, plus the appearance choice. */
export default function PersonalizeStep({ onContinue, onLater }: PersonalizeStepProps) {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.writingStyleOther);
  const setPersonal = useSettingsStore((state) => state.setWritingStylePersonal);
  const setWork = useSettingsStore((state) => state.setWritingStyleWork);
  const setEmail = useSettingsStore((state) => state.setWritingStyleEmail);
  const setOther = useSettingsStore((state) => state.setWritingStyleOther);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);

  const choose = (style: StyleId) => {
    setPersonal(style);
    setWork(style);
    setEmail(style);
    setOther(style);
  };

  return (
    <StepFrame
      title={
        <>
          {t("desktop.onboarding.personalize.titlePrefix")}{" "}
          <Accent>{t("desktop.onboarding.personalize.titleAccent")}</Accent>
          {t("desktop.onboarding.personalize.titleSuffix")}
        </>
      }
      description={t("desktop.onboarding.personalize.description")}
      width="xl"
    >
      <div className="onboarding-stagger grid w-full grid-cols-3 gap-3" role="radiogroup">
        {STYLES.map((style) => {
          const selected = value === style;
          return (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => choose(style)}
              className={`group relative flex min-h-40 flex-col rounded-xl border bg-[var(--onb-card)] p-4 text-left transition-all duration-150 hover:bg-[var(--onb-panel)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] ${
                selected
                  ? "border-[var(--onb-accent)] bg-[var(--onb-accent-soft)] hover:bg-[var(--onb-accent-soft)]"
                  : "border-[var(--onb-card-border)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold leading-6">
                    {t(`desktop.onboarding.personalize.names.${style}`)}
                  </p>
                  <p className="mt-0.5 text-xs leading-4 text-[var(--onb-ink-muted)]">
                    {t(`desktop.onboarding.personalize.hints.${style}`)}
                  </p>
                </div>
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-all ${
                    selected
                      ? "border-[var(--onb-accent)] bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)]"
                      : "border-[var(--onb-card-border)] opacity-0 group-hover:opacity-100"
                  }`}
                  aria-hidden="true"
                >
                  {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
              </div>
              <div className="mt-3 flex-1 whitespace-pre-line rounded-lg bg-[var(--onb-panel)] px-3.5 py-2.5 text-sm leading-6 text-[var(--onb-ink)]">
                {renderSample(t(`desktop.onboarding.personalize.samples.${style}`))}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-5 text-[var(--onb-ink-muted)]">
        {t("desktop.onboarding.personalize.legend")}
      </p>

      <section className="mt-6 w-full max-w-sm" aria-labelledby="onboarding-appearance">
        <h3 id="onboarding-appearance" className="mb-2 text-sm font-medium">
          {t("desktop.onboarding.personalize.appearance")}
        </h3>
        <div
          className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--onb-card-border)] bg-[var(--onb-card)] p-1"
          role="radiogroup"
        >
          {THEMES.map((option) => {
            const Icon = option.icon;
            const selectedTheme = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selectedTheme}
                onClick={() => setTheme(option.value)}
                className={`flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] ${
                  selectedTheme
                    ? "bg-[var(--onb-ink)] text-[var(--onb-bg)] shadow-sm"
                    : "text-[var(--onb-ink-muted)] hover:text-[var(--onb-ink)]"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={1.7} />
                {t(`desktop.onboarding.personalize.${option.key}`)}
              </button>
            );
          })}
        </div>
      </section>

      <div className="mt-6 flex items-center gap-3">
        <OnbButton variant="ghost" onClick={onLater}>
          {t("desktop.onboarding.personalize.later")}
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
