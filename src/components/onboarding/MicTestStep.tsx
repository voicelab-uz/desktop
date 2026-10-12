import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Headphones, Mic, RefreshCw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Card, OnbButton, Panel, StepFrame } from "./ui";
import { useMicLevel, type MicLevelError } from "../../hooks/useMicLevel";
import { useSettingsStore } from "../../stores/settingsStore";

interface MicTestStepProps {
  onReadyChange: (ready: boolean) => void;
}

const BAND_COUNT = 28;

export default function MicTestStep({ onReadyChange }: MicTestStepProps) {
  const { t } = useTranslation();
  const selectedMicDeviceId = useSettingsStore((state) => state.selectedMicDeviceId);
  const setSelectedMicDevice = useSettingsStore((state) => state.setSelectedMicDevice);
  const [showDevices, setShowDevices] = useState(false);
  const { bands, speechDetected, error, devices, refreshDevices } = useMicLevel(
    selectedMicDeviceId,
    BAND_COUNT
  );

  useEffect(() => {
    onReadyChange(speechDetected);
  }, [onReadyChange, speechDetected]);

  const errorCopy = error ? describeError(error, t) : null;

  return (
    <StepFrame
      title={t("desktop.onboarding.micTest.title")}
      description={t("desktop.onboarding.micTest.subtitle")}
      width="md"
    >
      <Card className="max-w-lg px-6 py-5">
        <p className="text-left text-base font-semibold leading-6">
          {t("desktop.onboarding.micTest.instruction")}
        </p>

        <Panel className="relative mt-4 flex h-28 items-end justify-center gap-1 overflow-hidden px-5 pb-5 pt-4">
          {bands.map((level, index) => (
            <span
              key={index}
              className={`w-2 rounded-full transition-[height,background-color] duration-75 ${
                speechDetected ? "bg-[var(--onb-success)]" : "bg-[var(--onb-accent)]"
              }`}
              style={{ height: `${Math.max(6, Math.round(level * 84) + 6)}px` }}
            />
          ))}
          <span className="pointer-events-none absolute left-4 top-3 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-[var(--onb-ink-muted)]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                speechDetected ? "bg-[var(--onb-success)]" : "bg-[var(--onb-accent)] animate-pulse"
              }`}
            />
            {t("desktop.onboarding.micTest.live")}
          </span>
        </Panel>

        <p
          className={`mt-4 flex items-center gap-1.5 text-sm font-medium ${
            speechDetected ? "text-[var(--onb-success)]" : "text-[var(--onb-ink)]"
          }`}
          role="status"
          aria-live="polite"
        >
          {speechDetected ? (
            <Check className="h-4 w-4" strokeWidth={2.5} />
          ) : (
            <Mic className="h-4 w-4" strokeWidth={1.8} />
          )}
          {errorCopy
            ? errorCopy.title
            : speechDetected
              ? t("desktop.onboarding.micTest.heard")
              : t("desktop.onboarding.micTest.speakToContinue")}
        </p>
        {errorCopy && (
          <p className="mt-1 text-left text-xs leading-5 text-[var(--onb-ink-muted)]">
            {errorCopy.body}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          {showDevices ? (
            <Select
              value={selectedMicDeviceId || "__default__"}
              onValueChange={(value) => {
                if (value === "__default__") {
                  setSelectedMicDevice("", "");
                  return;
                }
                const device = devices.find((item) => item.deviceId === value);
                setSelectedMicDevice(value, device?.label ?? "");
              }}
            >
              <SelectTrigger
                className="h-10 w-72 rounded-xl border-[var(--onb-card-border)] bg-[var(--onb-card)]"
                aria-label={t("desktop.onboarding.micTest.changeMic")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t("desktop.onboarding.micTest.defaultMic")}
                </SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <OnbButton
              variant="secondary"
              size="sm"
              onClick={() => {
                void refreshDevices();
                setShowDevices(true);
              }}
            >
              {t("desktop.onboarding.micTest.changeMic")}
            </OnbButton>
          )}
          {error && (
            <OnbButton
              variant="ghost"
              size="sm"
              onClick={() => {
                void refreshDevices();
                setSelectedMicDevice("", "");
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {t("desktop.onboarding.micTest.refresh")}
            </OnbButton>
          )}
        </div>
      </Card>

      <div className="mt-4 flex max-w-lg items-start gap-3 rounded-lg border border-[var(--onb-card-border)] bg-[var(--onb-card)]/70 px-4 py-3 text-left">
        <Headphones
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--onb-accent)]"
          strokeWidth={1.8}
        />
        <p className="text-xs leading-5 text-[var(--onb-ink-muted)]">
          <span className="mr-1.5 font-semibold uppercase tracking-wide text-[var(--onb-ink)]">
            {t("desktop.onboarding.micTest.quickTipLabel")}
          </span>
          {t("desktop.onboarding.micTest.quickTip")}
        </p>
      </div>
    </StepFrame>
  );
}

function describeError(error: MicLevelError, t: (key: string) => string) {
  const map: Record<MicLevelError, string> = {
    "not-allowed": "notAllowed",
    "not-found": "notFound",
    "in-use": "inUse",
    unknown: "unknown",
  };
  const key = map[error];
  return {
    title: t(`desktop.onboarding.micTest.errors.${key}Title`),
    body: t(`desktop.onboarding.micTest.errors.${key}Body`),
  };
}
