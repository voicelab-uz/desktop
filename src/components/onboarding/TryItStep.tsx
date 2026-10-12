import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks, Mail, MessageSquare, Sparkles } from "lucide-react";
import { Accent, Card, Celebration, ShortcutSentence, StepFrame } from "./ui";
import { shortcutSentence, type ActivationMode } from "./shortcutCopy";
import { isGlobeLikeHotkey } from "../../utils/hotkeys";

export interface DictationStats {
  words: number;
  seconds: number | null;
}

export type TryItVariant = "message" | "email" | "list";

interface TryItStepProps {
  variant: TryItVariant;
  hotkey: string;
  activationMode: ActivationMode;
  firstName: string | null;
  onComplete: (stats: DictationStats) => void;
  onReadyChange: (ready: boolean) => void;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const VARIANT_ICON = { message: MessageSquare, email: Mail, list: ListChecks };

export default function TryItStep({
  variant,
  hotkey,
  activationMode,
  firstName,
  onComplete,
  onReadyChange,
}: TryItStepProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const startedAtRef = useRef<number | null>(null);
  const [value, setValue] = useState("");
  const [done, setDone] = useState(false);
  const [focused, setFocused] = useState(false);
  const base = `desktop.onboarding.tryIt.${variant}`;
  const Icon = VARIANT_ICON[variant];

  useEffect(() => {
    onReadyChange(done);
  }, [done, onReadyChange]);

  // The dictation overlay stays hidden during onboarding; the practice
  // screens are where the person actually dictates, so bring it on screen.
  useEffect(() => {
    void window.electronAPI?.showDictationPanel?.();
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 350);
    return () => window.clearTimeout(timer);
  }, []);

  const markStart = useCallback(() => {
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (isGlobeLikeHotkey(hotkey)) {
      return window.electronAPI?.onGlobeKeyPressed?.(markStart);
    }
    const handleKeyDown = () => markStart();
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hotkey, markStart]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onDictationComplete?.(({ text }) => {
      const finishedAt = Date.now();
      const startedAt = startedAtRef.current;
      // Text insertion pastes into the focused textarea on its own; give it a
      // moment, then make sure the result is visible even if the paste missed.
      window.setTimeout(() => {
        setValue((current) => (current.trim() ? current : text));
      }, 350);
      setDone(true);
      onComplete({
        words: countWords(text),
        seconds: startedAt ? Math.max(1, (finishedAt - startedAt) / 1000) : null,
      });
    });
    return () => unsubscribe?.();
  }, [onComplete]);

  const greetingName = firstName || t("desktop.onboarding.tryIt.greetingFallback");
  const placeholder = shortcutSentence(t, "desktop.onboarding.tryIt.placeholder", activationMode)
    .split("⟪KEY⟫")
    .join(hotkeyDisplay(hotkey));

  const textarea = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      rows={variant === "message" ? 2 : 4}
      spellCheck={false}
      aria-label={t(`${base}.title`)}
      placeholder={placeholder}
      className="w-full resize-none bg-transparent text-sm leading-6 text-[var(--onb-ink)] outline-none placeholder:text-[var(--onb-ink-muted)] placeholder:opacity-70"
    />
  );

  return (
    <StepFrame
      title={
        <>
          {t(`${base}.titlePrefix`)} <Accent>{t(`${base}.titleAccent`)}</Accent>
          {t(`${base}.titleSuffix`)}
        </>
      }
      description={
        <ShortcutSentence
          text={shortcutSentence(t, "desktop.onboarding.tryIt.subtitle", activationMode)}
          hotkey={hotkey}
        />
      }
      width="md"
    >
      <Card className="relative max-w-lg overflow-visible">
        <div className="flex items-center gap-2 border-b border-[var(--onb-card-border)] px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 flex items-center gap-1.5 text-xs font-medium text-[var(--onb-ink-muted)]">
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {t(`${base}.windowTitle`)}
          </span>
        </div>

        {variant === "message" && (
          <div className="space-y-3 px-4 pt-4 text-left">
            <div className="flex items-end gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--onb-ink)] text-2xs font-semibold text-[var(--onb-bg)]">
                VL
              </span>
              <p className="max-w-[80%] rounded-2xl rounded-bl-md bg-[var(--onb-panel)] px-3.5 py-2 text-sm leading-5">
                {t("desktop.onboarding.tryIt.message.greeting", { firstName: greetingName })}
              </p>
            </div>
            {done && value.trim() && (
              <div className="flex justify-end animate-[onboarding-bubble-in_300ms_ease-out_both]">
                <p className="max-w-[80%] rounded-2xl rounded-br-md bg-[var(--onb-ink)] px-3.5 py-2 text-sm leading-5 text-[var(--onb-bg)]">
                  {value}
                </p>
              </div>
            )}
          </div>
        )}

        {variant === "email" && (
          <div className="divide-y divide-[var(--onb-card-border)] text-left text-sm">
            <div className="flex gap-3 px-4 py-2">
              <span className="w-16 text-[var(--onb-ink-muted)]">
                {t("desktop.onboarding.tryIt.email.toLabel")}
              </span>
              <span className="font-medium">{t("desktop.onboarding.tryIt.email.toValue")}</span>
            </div>
            <div className="flex gap-3 px-4 py-2">
              <span className="w-16 text-[var(--onb-ink-muted)]">
                {t("desktop.onboarding.tryIt.email.subjectLabel")}
              </span>
              <span className="font-medium">
                {t("desktop.onboarding.tryIt.email.subjectValue")}
              </span>
            </div>
          </div>
        )}

        {variant === "list" && (
          <div className="px-4 pt-4 text-left">
            <p className="text-base font-semibold">
              {t("desktop.onboarding.tryIt.list.pageTitle")}
            </p>
          </div>
        )}

        <div className="px-4 pb-4 pt-3">
          <div
            className={`rounded-xl border px-3.5 py-2.5 transition-all ${
              focused
                ? "border-[var(--onb-accent)] ring-4 ring-[var(--onb-accent-soft)]"
                : "border-[var(--onb-card-border)]"
            }`}
          >
            {textarea}
          </div>
          {!focused && !done && (
            <p
              className="mt-2 text-left text-xs font-medium text-[var(--onb-accent)]"
              role="status"
            >
              {t("desktop.onboarding.tryIt.clickTextbox")}
            </p>
          )}
        </div>

        {done && (
          <>
            <Celebration className="top-1/3" />
            <div
              className="pointer-events-none absolute -right-3 -top-4 flex items-center gap-1.5 rounded-full bg-[var(--onb-success)] px-3.5 py-2 text-sm font-semibold text-white shadow-lg animate-[onboarding-sticker-pop_500ms_cubic-bezier(0.34,1.56,0.64,1)_both]"
              role="status"
            >
              <Sparkles className="h-4 w-4" strokeWidth={2.2} />
              {t("desktop.onboarding.tryIt.wellDone")}
            </div>
          </>
        )}
      </Card>

      {!done && (
        <p className="mt-5 max-w-xl text-xs leading-5 text-[var(--onb-ink-muted)]">
          <span className="font-semibold text-[var(--onb-ink)]">
            {t("desktop.onboarding.tryIt.trySaying")}
          </span>{" "}
          “{t(`${base}.sample`)}”
        </p>
      )}
      {done && (
        <p className="mt-5 max-w-xl text-sm leading-5 text-[var(--onb-ink-muted)]">
          {t(`${base}.afterwards`)}
        </p>
      )}
    </StepFrame>
  );
}

function hotkeyDisplay(hotkey: string): string {
  return isGlobeLikeHotkey(hotkey) ? "fn" : hotkey.replace(/\+/g, " + ");
}
