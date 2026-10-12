import { useTranslation } from "react-i18next";
import { Database, LockKeyhole, Sparkles } from "lucide-react";
import { Card, OnbSwitch, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

export default function PrivacyStep() {
  const { t } = useTranslation();
  const dataRetentionEnabled = useSettingsStore((state) => state.dataRetentionEnabled);
  const setDataRetentionEnabled = useSettingsStore((state) => state.setDataRetentionEnabled);
  const telemetryEnabled = useSettingsStore((state) => state.telemetryEnabled);
  const setTelemetryEnabled = useSettingsStore((state) => state.setTelemetryEnabled);

  const rows = [
    {
      id: "history",
      icon: Database,
      title: t("desktop.onboarding.privacy.historyTitle"),
      description: t("desktop.onboarding.privacy.historyDescription"),
      checked: dataRetentionEnabled,
      onChange: setDataRetentionEnabled,
    },
    {
      id: "usage",
      icon: Sparkles,
      title: t("desktop.onboarding.privacy.usageTitle"),
      description: t("desktop.onboarding.privacy.usageDescription"),
      checked: telemetryEnabled,
      onChange: setTelemetryEnabled,
    },
  ];

  return (
    <StepFrame
      title={t("desktop.onboarding.privacy.title")}
      description={t("desktop.onboarding.privacy.description")}
      width="md"
    >
      <Card className="max-w-lg divide-y divide-[var(--onb-card-border)]">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <div key={row.id} className="flex items-center gap-4 px-5 py-4 text-left">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--onb-panel)] text-[var(--onb-ink)]">
                <Icon className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5">{row.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-[var(--onb-ink-muted)]">
                  {row.description}
                </p>
              </div>
              <OnbSwitch checked={row.checked} onChange={row.onChange} label={row.title} />
            </div>
          );
        })}
      </Card>
      <p className="mt-5 flex max-w-xl items-center gap-2 text-xs leading-5 text-[var(--onb-ink-muted)]">
        <LockKeyhole className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
        {t("desktop.onboarding.privacy.note")}
      </p>
    </StepFrame>
  );
}
