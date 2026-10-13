import * as React from "react";
import { Check, CircleCheck, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { ToastContext, type ToastProps, type ToastRecord } from "./useToast";
import { isDictationPanelWindow } from "../../utils/windowContext";
import { playErrorCue, playNotificationCue } from "../../utils/dictationCues";
import { getSettings } from "../../stores/settingsStore";

type ToastState = ToastRecord;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);
  const timersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearTimer = React.useCallback((id: string) => {
    const timer = timersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[id];
    }
  }, []);

  const startExitAnimation = React.useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, isExiting: true } : t)));
    // Long enough for the dictation island to shrink back before the toast leaves.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 360);
  }, []);

  const toast = React.useCallback(
    (props: Omit<ToastProps, "id">): string => {
      const id = Math.random().toString(36).substring(2, 11);
      const isError = props.variant === "destructive";

      // The global preference intentionally keeps errors visible, but hides
      // ordinary success/info toasts and their notification sound.
      if (!isError && !getSettings().notificationsEnabled) return id;
      // Store the resolved duration so the close-button ring and the timer agree.
      const duration = props.duration ?? (props.variant === "destructive" ? 6000 : 3500);
      const newToast: ToastState = { ...props, duration, id, createdAt: Date.now() };

      void (isError ? playErrorCue() : playNotificationCue());
      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, duration);
        timersRef.current[id] = timer;
      }

      return id;
    },
    [startExitAnimation]
  );

  const dismiss = React.useCallback(
    (id?: string) => {
      if (id) {
        clearTimer(id);
        startExitAnimation(id);
      } else {
        const lastToast = toasts[toasts.length - 1];
        if (lastToast) {
          clearTimer(lastToast.id);
          startExitAnimation(lastToast.id);
        }
      }
    },
    [toasts, clearTimer, startExitAnimation]
  );

  const pauseTimer = React.useCallback(
    (id: string) => {
      clearTimer(id);
    },
    [clearTimer]
  );

  const resumeTimer = React.useCallback(
    (id: string, remainingTime: number) => {
      if (remainingTime > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, remainingTime);
        timersRef.current[id] = timer;
      }
    },
    [startExitAnimation]
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id in timers) {
        clearTimeout(timers[id]);
      }
    };
  }, []);

  return (
    <ToastContext.Provider
      value={{ toast, dismiss, toastCount: toasts.length, toasts, pauseTimer, resumeTimer }}
    >
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismiss}
        onPauseTimer={pauseTimer}
        onResumeTimer={resumeTimer}
      />
    </ToastContext.Provider>
  );
};

const ToastViewport: React.FC<{
  toasts: ToastState[];
  onDismiss: (id: string) => void;
  onPauseTimer: (id: string) => void;
  onResumeTimer: (id: string, remainingTime: number) => void;
}> = ({ toasts, onDismiss, onPauseTimer, onResumeTimer }) => {
  const isDictationPanel = React.useMemo(isDictationPanelWindow, []);

  // The dictation overlay morphs its own control into the notice instead.
  if (isDictationPanel || toasts.length === 0) return null;

  return (
    <div className="fixed z-[100] flex flex-col gap-2 pointer-events-none bottom-5 right-5">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...toast}
          onClose={() => onDismiss(toast.id)}
          onPauseTimer={() => onPauseTimer(toast.id)}
          onResumeTimer={(remaining) => onResumeTimer(toast.id, remaining)}
        />
      ))}
    </div>
  );
};

const variantConfig = {
  default: {
    accentClass: "bg-white/20",
    progressClass: "bg-white/15",
    iconClass: "text-white/70",
    Icon: Info,
  },
  destructive: {
    accentClass: "bg-red-400",
    progressClass: "bg-red-400/30",
    iconClass: "text-amber-300",
    Icon: TriangleAlert,
  },
  success: {
    accentClass: "bg-emerald-400",
    progressClass: "bg-emerald-400/30",
    iconClass: "text-emerald-300",
    Icon: CircleCheck,
  },
};

type ToastComponentProps = ToastState & {
  onClose?: () => void;
  onPauseTimer: () => void;
  onResumeTimer: (remaining: number) => void;
};

function useHoverPause({
  createdAt,
  duration,
  onPauseTimer,
  onResumeTimer,
}: Pick<ToastComponentProps, "createdAt" | "duration" | "onPauseTimer" | "onResumeTimer">) {
  const pausedAtRef = React.useRef<number | null>(null);
  const handleMouseEnter = () => {
    pausedAtRef.current = Date.now();
    onPauseTimer();
  };
  const handleMouseLeave = () => {
    if (pausedAtRef.current && duration && duration > 0) {
      const elapsed = pausedAtRef.current - createdAt;
      const remaining = Math.max(duration - elapsed, 500);
      onResumeTimer(remaining);
    }
    pausedAtRef.current = null;
  };
  return { handleMouseEnter, handleMouseLeave };
}

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export type NoticeContentProps = ToastComponentProps;

/**
 * Body of a notice: icon, bold headline, plain-language explanation, optional
 * technical details and action. The close button carries a thin ring that
 * drains as the notice auto-dismisses. The dictation island morphs around it.
 */
export const NoticeContent: React.FC<NoticeContentProps> = ({
  title,
  description,
  icon,
  action,
  variant = "default",
  duration = 3500,
  isExiting,
  createdAt,
  onClose,
  onPauseTimer,
  onResumeTimer,
}) => {
  const { t } = useTranslation();
  const config = variantConfig[variant];
  const Icon = config.Icon;
  const [ringPaused, setRingPaused] = React.useState(false);
  const hover = useHoverPause({ createdAt, duration, onPauseTimer, onResumeTimer });
  const handleMouseEnter = () => {
    setRingPaused(true);
    hover.handleMouseEnter();
  };
  const handleMouseLeave = () => {
    setRingPaused(false);
    hover.handleMouseLeave();
  };

  const headline = title || description;
  const body = title && description ? description : undefined;

  return (
    <div
      role={variant === "destructive" ? "alert" : "status"}
      className="px-5 pb-4 pt-4 text-white"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 shrink-0", config.iconClass)} aria-hidden="true">
          {icon ?? <Icon className="size-5" strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-1 pt-px">
          {headline && <p className="text-base font-semibold leading-6 text-white">{headline}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "relative -mr-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full",
              "text-white/80 transition-colors hover:bg-white/10 hover:text-white",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
            )}
          >
            <svg
              className="pointer-events-none absolute inset-0 size-9 -rotate-90"
              viewBox="0 0 36 36"
              aria-hidden="true"
            >
              <circle
                cx="18"
                cy="18"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeWidth="1.5"
              />
              {duration > 0 && !isExiting && (
                <circle
                  cx="18"
                  cy="18"
                  r={RING_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  style={{
                    animation: `notice-ring ${duration}ms linear forwards`,
                    animationPlayState: ringPaused ? "paused" : "running",
                  }}
                />
              )}
            </svg>
            <X className="size-4" strokeWidth={2.2} />
            <span className="sr-only">{t("common.close")}</span>
          </button>
        )}
      </div>

      {body && <p className="mt-2 text-sm leading-6 text-white/60">{body}</p>}

      {action && <div className="mt-3 flex justify-end">{action}</div>}
    </div>
  );
};

const Toast: React.FC<ToastComponentProps> = ({
  title,
  description,
  action,
  variant = "default",
  duration = 3500,
  isExiting,
  createdAt,
  onClose,
  onPauseTimer,
  onResumeTimer,
}) => {
  const { t } = useTranslation();
  const config = variantConfig[variant];
  const [copied, setCopied] = React.useState(false);
  const isDestructive = variant === "destructive";
  const { handleMouseEnter, handleMouseLeave } = useHoverPause({
    createdAt,
    duration,
    onPauseTimer,
    onResumeTimer,
  });

  const handleCopyError = async () => {
    if (!description) return;
    try {
      await navigator.clipboard.writeText(description);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const message = title || description;
  const detail = title && description ? description : undefined;

  return (
    <div
      className={cn(
        "group toast-surface pointer-events-auto relative flex w-75",
        "rounded-[5px]",
        "transition-[opacity,transform] duration-200 ease-out",
        isExiting
          ? "opacity-0 translate-x-2 scale-[0.98]"
          : "opacity-100 translate-x-0 scale-100 animate-in slide-in-from-right-4 fade-in-0 duration-300"
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={cn("w-0.5 shrink-0", config.accentClass)} />

      <div className="flex items-start gap-2 flex-1 min-w-0 px-2.5 py-2">
        <div className="flex-1 min-w-0">
          {message && (
            <div className="text-xs font-medium leading-tight text-white/90">{message}</div>
          )}
          {detail &&
            (isDestructive ? (
              <div
                className={cn(
                  "text-xs leading-snug mt-1 px-1.5 py-1 rounded-[3px] font-mono",
                  "bg-white/4 border border-white/6",
                  "text-red-300/80"
                )}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="select-all wrap-break-word min-w-0">{detail}</span>
                  <button
                    onClick={handleCopyError}
                    className={cn(
                      "shrink-0 p-0.5 rounded-xs mt-px",
                      "text-white/30 hover:text-white/70",
                      "hover:bg-white/6",
                      "transition-colors duration-150"
                    )}
                    aria-label={t("common.copyError")}
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs leading-snug mt-0.5 text-white/45">{detail}</div>
            ))}
        </div>

        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>

      {onClose && (
        <button
          onClick={onClose}
          className={cn(
            "absolute -left-2 -top-2 size-6 rounded-full",
            "flex items-center justify-center",
            "bg-white/10 backdrop-blur-sm border border-white/10",
            "text-white/70 hover:text-white hover:bg-white/20",
            "opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100",
            "transition-all duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
          )}
        >
          <X className="size-3" />
          <span className="sr-only">{t("common.close")}</span>
        </button>
      )}

      {duration > 0 && !isExiting && (
        <div className="absolute bottom-0 left-0.5 right-0 h-px overflow-hidden">
          <div
            className={cn("h-full", config.progressClass)}
            style={{
              animation: `toast-progress ${duration}ms linear forwards`,
            }}
          />
        </div>
      )}
    </div>
  );
};
