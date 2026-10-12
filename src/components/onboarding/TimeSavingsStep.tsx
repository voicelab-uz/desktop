import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Mic } from "lucide-react";
import { Accent, Card, StepFrame } from "./ui";
import type { DictationStats } from "./TryItStep";

interface TimeSavingsStepProps {
  stats: DictationStats | null;
}

const AVERAGE_TYPING_WPM = 40;
const ILLUSTRATIVE_SPEAKING_WPM = 130;
const WORK_DAYS_PER_WEEK = 5;

function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased * 10) / 10);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [duration, target]);
  return value;
}

export default function TimeSavingsStep({ stats }: TimeSavingsStepProps) {
  const { t } = useTranslation();
  const [hoursPerDay, setHoursPerDay] = useState(2);
  const measuredWpm =
    stats && stats.seconds ? Math.round((stats.words / stats.seconds) * 60) : null;
  const hasMeasurement = measuredWpm !== null && measuredWpm > AVERAGE_TYPING_WPM;
  const voiceWpm = hasMeasurement ? measuredWpm : ILLUSTRATIVE_SPEAKING_WPM;
  const multiplier = Math.max(1, Math.round((voiceWpm / AVERAGE_TYPING_WPM) * 10) / 10);
  const savedFraction = Math.max(0, 1 - AVERAGE_TYPING_WPM / voiceWpm);
  const savedHoursPerWeek = Math.round(hoursPerDay * WORK_DAYS_PER_WEEK * savedFraction * 10) / 10;
  const animatedMultiplier = useCountUp(multiplier);
  const animatedSaved = useCountUp(savedHoursPerWeek, 600);
  const maxWpm = Math.max(voiceWpm, AVERAGE_TYPING_WPM);

  const rows = [
    {
      id: "voice",
      icon: Mic,
      label: t("desktop.onboarding.timeSavings.yourVoice"),
      wpm: voiceWpm,
      accent: true,
    },
    {
      id: "typing",
      icon: Keyboard,
      label: t("desktop.onboarding.timeSavings.avgTyping"),
      wpm: AVERAGE_TYPING_WPM,
      accent: false,
    },
  ];

  return (
    <StepFrame
      title={t("desktop.onboarding.timeSavings.title")}
      description={
        hasMeasurement
          ? t("desktop.onboarding.timeSavings.spoke", { count: measuredWpm })
          : t("desktop.onboarding.timeSavings.generic")
      }
      width="md"
    >
      <div className="flex flex-col items-center">
        <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums">
          <Accent>
            {t("desktop.onboarding.timeSavings.faster", { multiplier: animatedMultiplier })}
          </Accent>
        </span>
        <span className="mt-2 text-sm text-[var(--onb-ink-muted)]">
          {t("desktop.onboarding.timeSavings.fasterSubtitle")}
        </span>
      </div>

      <Card className="mt-5 max-w-lg space-y-2.5 px-5 py-4">
        {rows.map((row) => {
          const Icon = row.icon;
          const width = `${Math.max(16, Math.round((row.wpm / maxWpm) * 100))}%`;
          return (
            <div key={row.id} className="flex items-center gap-3">
              <span className="flex w-40 shrink-0 items-center gap-2 text-left text-xs font-medium text-[var(--onb-ink-muted)]">
                <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                {row.label}
              </span>
              <div className="relative h-8 flex-1 overflow-hidden rounded-lg bg-[var(--onb-panel)]">
                <div
                  className={`flex h-full items-center justify-end rounded-lg pr-3 text-xs font-semibold tabular-nums animate-[onboarding-bar-grow_800ms_cubic-bezier(0.22,1,0.36,1)_both] ${
                    row.accent
                      ? "bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)]"
                      : "bg-[var(--onb-key-border)] text-[var(--onb-ink)]"
                  }`}
                  style={{ width }}
                >
                  {t("desktop.onboarding.timeSavings.wpm", { count: row.wpm })}
                </div>
              </div>
            </div>
          );
        })}
      </Card>

      <Card className="mt-3 max-w-lg px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="onboarding-typing-hours" className="text-left text-sm font-medium">
            {t("desktop.onboarding.timeSavings.sliderLabel")}
          </label>
          <span className="text-sm font-semibold tabular-nums">
            {t("desktop.onboarding.timeSavings.hours", { count: hoursPerDay })}
          </span>
        </div>
        <input
          id="onboarding-typing-hours"
          type="range"
          min={1}
          max={8}
          step={1}
          value={hoursPerDay}
          onChange={(event) => setHoursPerDay(Number(event.target.value))}
          className="mt-3 w-full accent-[var(--onb-accent)]"
        />
        <p className="mt-3 text-sm text-[var(--onb-ink-muted)]">
          {t("desktop.onboarding.timeSavings.savePrefix")}{" "}
          <span className="text-xl font-semibold tabular-nums text-[var(--onb-ink)]">
            {t("desktop.onboarding.timeSavings.saveHours", { count: animatedSaved })}
          </span>{" "}
          {t("desktop.onboarding.timeSavings.saveSuffix")}
        </p>
      </Card>
    </StepFrame>
  );
}
