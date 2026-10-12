import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil } from "lucide-react";
import { HotkeyInput } from "../ui/HotkeyInput";
import { Card, Keycap, OnbButton, Panel, ShortcutSentence, StepFrame } from "./ui";
import { shortcutSentence, type ActivationMode } from "./shortcutCopy";
import { isGlobeLikeHotkey, parseHotkey } from "../../utils/hotkeys";

interface ShortcutStepProps {
  hotkey: string;
  activationMode: ActivationMode;
  isRegistering: boolean;
  onHotkeyChange: (hotkey: string) => Promise<boolean>;
  onReadyChange: (ready: boolean) => void;
  onConfirm: () => void;
}

const KEY_ALIASES: Record<string, string[]> = {
  control: ["control", "ctrl"],
  command: ["meta", "command", "cmd", "commandorcontrol"],
  commandorcontrol: ["meta", "control", "commandorcontrol"],
  alt: ["alt", "option"],
  option: ["alt", "option"],
  super: ["meta", "super", "os"],
  space: [" ", "space"],
  capslock: ["capslock"],
};

function keyMatches(eventKey: string, eventCode: string, hotkeyKey: string): boolean {
  const key = eventKey.toLowerCase();
  const code = eventCode.toLowerCase();
  const target = hotkeyKey.toLowerCase();
  if (key === target || code === target || code === `key${target}` || code === `digit${target}`) {
    return true;
  }
  const aliases = KEY_ALIASES[target];
  return aliases ? aliases.some((alias) => key === alias || code.startsWith(alias)) : false;
}

export default function ShortcutStep({
  hotkey,
  activationMode,
  isRegistering,
  onHotkeyChange,
  onReadyChange,
  onConfirm,
}: ShortcutStepProps) {
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  const [detected, setDetected] = useState(false);
  const [editing, setEditing] = useState(false);
  const ready = detected && !editing;

  useEffect(() => {
    onReadyChange(ready);
  }, [onReadyChange, ready]);

  // A new shortcut must be verified again.
  useEffect(() => {
    setDetected(false);
    setPressed(false);
  }, [hotkey]);

  const markPressed = useCallback(() => {
    setPressed(true);
    setDetected(true);
  }, []);

  useEffect(() => {
    if (editing) return undefined;

    if (isGlobeLikeHotkey(hotkey)) {
      const offPressed = window.electronAPI?.onGlobeKeyPressed?.(markPressed);
      const offReleased = window.electronAPI?.onGlobeKeyReleased?.(() => setPressed(false));
      return () => {
        offPressed?.();
        offReleased?.();
      };
    }

    const { baseKey } = parseHotkey(hotkey);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (keyMatches(event.key, event.code, baseKey)) markPressed();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (keyMatches(event.key, event.code, baseKey)) setPressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [editing, hotkey, markPressed]);

  return (
    <StepFrame
      title={t("desktop.onboarding.shortcut.title")}
      description={
        <ShortcutSentence
          text={shortcutSentence(t, "desktop.onboarding.shortcut.subtitle", activationMode)}
          hotkey={hotkey}
        />
      }
      width="md"
    >
      <Card className="max-w-lg px-6 py-5">
        {editing ? (
          <>
            <p className="text-left text-base font-semibold leading-6">
              {t("desktop.onboarding.shortcut.capture")}
            </p>
            <div className="mt-4">
              <HotkeyInput
                variant="onboarding"
                value={hotkey}
                autoFocus
                disabled={isRegistering}
                onChange={async (value) => {
                  if (await onHotkeyChange(value)) setEditing(false);
                }}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <OnbButton variant="secondary" size="sm" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </OnbButton>
            </div>
          </>
        ) : (
          <>
            <p className="text-left text-base font-semibold leading-6">
              {detected
                ? t("desktop.onboarding.shortcut.detected")
                : t("desktop.onboarding.shortcut.instruction")}
            </p>

            <Panel className="relative mt-4 flex h-40 flex-col items-center justify-center gap-4">
              <Keycap hotkey={hotkey} size="lg" pressed={pressed} active={detected} />
              {!detected && (
                <span className="text-xs text-[var(--onb-ink-muted)]">
                  {t("desktop.onboarding.shortcut.pressHint")}
                </span>
              )}
              {detected && (
                <span className="flex items-center gap-1 text-xs font-medium text-[var(--onb-success)]">
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  {t("desktop.onboarding.shortcut.works")}
                </span>
              )}
            </Panel>

            <div className="mt-5 flex items-center justify-between gap-3">
              <OnbButton variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                {t("desktop.onboarding.shortcut.change")}
              </OnbButton>
              <div className="flex items-center gap-2">
                <OnbButton variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  {t("desktop.onboarding.shortcut.no")}
                </OnbButton>
                <OnbButton
                  size="sm"
                  data-testid="onboarding-shortcut-yes"
                  onClick={() => {
                    setDetected(true);
                    onConfirm();
                  }}
                >
                  {t("desktop.onboarding.shortcut.yes")}
                </OnbButton>
              </div>
            </div>
          </>
        )}
      </Card>
      <p className="mt-4 max-w-md text-xs leading-5 text-[var(--onb-ink-muted)]">
        {t("desktop.onboarding.shortcut.recommend")}
      </p>
    </StepFrame>
  );
}
