import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Accent, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

export type StyleContext = "personal" | "work" | "email" | "other";
type StyleId = "casual" | "formal" | "excited";

const STYLES_BY_CONTEXT: Record<StyleContext, StyleId[]> = {
  personal: ["casual", "formal"],
  work: ["casual", "formal", "excited"],
  email: ["casual", "formal", "excited"],
  other: ["casual", "formal", "excited"],
};

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

export default function StyleStep({ context }: { context: StyleContext }) {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => {
    switch (context) {
      case "personal":
        return state.writingStylePersonal;
      case "work":
        return state.writingStyleWork;
      case "email":
        return state.writingStyleEmail;
      default:
        return state.writingStyleOther;
    }
  });
  const setPersonal = useSettingsStore((state) => state.setWritingStylePersonal);
  const setWork = useSettingsStore((state) => state.setWritingStyleWork);
  const setEmail = useSettingsStore((state) => state.setWritingStyleEmail);
  const setOther = useSettingsStore((state) => state.setWritingStyleOther);
  const setValue = { personal: setPersonal, work: setWork, email: setEmail, other: setOther }[
    context
  ];
  const styles = STYLES_BY_CONTEXT[context];
  const base = `desktop.onboarding.style.${context}`;

  return (
    <StepFrame
      title={
        <>
          {t("desktop.onboarding.style.titlePrefix")} <Accent>{t(`${base}.subject`)}</Accent>
          {t("desktop.onboarding.style.titleSuffix")}
        </>
      }
      description={t(`${base}.description`)}
      width="xl"
    >
      <div
        className={`onboarding-stagger grid w-full gap-3 ${styles.length === 2 ? "max-w-xl grid-cols-2" : "grid-cols-3"}`}
        role="radiogroup"
      >
        {styles.map((style) => {
          const selected = value === style;
          return (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setValue(style)}
              className={`group relative flex min-h-44 flex-col rounded-xl border bg-[var(--onb-card)] p-4 text-left transition-all duration-150 hover:bg-[var(--onb-panel)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] ${
                selected
                  ? "border-[var(--onb-accent)] bg-[var(--onb-accent-soft)] hover:bg-[var(--onb-accent-soft)]"
                  : "border-[var(--onb-card-border)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold leading-6">
                    {t(`desktop.onboarding.style.names.${style}`)}
                  </p>
                  <p className="mt-0.5 text-xs leading-4 text-[var(--onb-ink-muted)]">
                    {t(`desktop.onboarding.style.hints.${style}`)}
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
                {renderSample(t(`${base}.samples.${style}`))}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-xs leading-5 text-[var(--onb-ink-muted)]">
        {t("desktop.onboarding.style.legend")}
      </p>
    </StepFrame>
  );
}
