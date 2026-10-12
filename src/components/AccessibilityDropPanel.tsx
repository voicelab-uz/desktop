import { Fragment, useCallback, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, X } from "lucide-react";
import appIcon from "../assets/icon.png";

const APP_NAME = "VoiceLab";

/**
 * Floating helper rendered in its own always-on-top window while System
 * Settings is open: dragging the tile starts a native drag of the app bundle so
 * it can be dropped into the Accessibility list.
 */
export default function AccessibilityDropPanel() {
  const { t } = useTranslation();
  const permission = t("desktop.accessibilityDrop.permission");
  const instruction = t("desktop.accessibilityDrop.instruction", { app: APP_NAME, permission });

  const handleDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    window.electronAPI?.accessibilityDropStartDrag?.();
  }, []);

  const handleHide = useCallback(() => {
    void window.electronAPI?.hideAccessibilityDrop?.();
  }, []);

  const highlighted = instruction.split(new RegExp(`(${APP_NAME}|${permission})`, "g"));

  return (
    <div className="accessibility-drop-window flex h-screen w-screen items-end justify-center bg-transparent p-2">
      <div
        className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-neutral-900/95 px-4 py-3 text-neutral-100 shadow-[0_18px_48px_-18px_rgba(0,0,0,0.8)] backdrop-blur-xl animate-[onboarding-rise_420ms_cubic-bezier(0.22,1,0.36,1)_both]"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#2f7cf6] text-white animate-[onboarding-key-press_1800ms_ease-in-out_infinite]">
          <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
        </span>

        <p className="min-w-0 flex-1 text-sm leading-5">
          {highlighted.map((part, index) =>
            part === APP_NAME || part === permission ? (
              <strong key={index} className="font-semibold text-white">
                {part}
              </strong>
            ) : (
              <Fragment key={index}>{part}</Fragment>
            )
          )}
        </p>

        <div
          draggable
          onDragStart={handleDragStart}
          role="button"
          tabIndex={0}
          aria-label={t("desktop.accessibilityDrop.dragHint")}
          title={t("desktop.accessibilityDrop.dragHint")}
          className="flex shrink-0 cursor-grab select-none items-center gap-2.5 rounded-xl border border-white/15 bg-neutral-800 px-3 py-2 transition-colors hover:border-white/30 hover:bg-neutral-700 active:cursor-grabbing"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <img src={appIcon} alt="" className="h-7 w-7 rounded-md" draggable={false} />
          <span className="text-sm font-semibold">{APP_NAME}</span>
        </div>

        <button
          type="button"
          onClick={handleHide}
          aria-label={t("desktop.accessibilityDrop.hide")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
