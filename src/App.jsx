// @refresh reset
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { Minus, X } from "lucide-react";
import { useToast } from "./components/ui/useToast";
import { NoticeContent } from "./components/ui/Toast";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore } from "./stores/settingsStore";

const AUDIO_BAR_SHAPE = [0.5, 0.1, 0.9, 0.3, 0.6, 0.7, 0.2, 0.4];

const AudioLevelBars = ({ audioLevel, active = false, processing = false }) => {
  const level = Math.min(1, Math.max(0, Number(audioLevel) || 0));

  return (
    <span
      className={`voice-level-bars${processing ? " voice-level-bars--processing" : ""}`}
      aria-label="Microphone input level"
      role="img"
    >
      {AUDIO_BAR_SHAPE.map((shape, index) => {
        const height = active
          ? 4 + Math.round(level * (7 + shape * 16))
          : processing
            ? 6 + Math.round(shape * 9)
            : 5 + Math.round(shape * 5);
        const opacity = active ? 0.42 + level * 0.58 : processing ? 0.64 : 0.42;

        return (
          <span
            key={index}
            className="voice-level-bars__bar"
            style={{ "--voice-bar-index": index, height: `${height}px`, opacity }}
          />
        );
      })}
    </span>
  );
};

// The island pill and the notice card it morphs into (px).
const ISLAND_WIDTH = 74;
const ISLAND_HEIGHT = 44;
const NOTICE_WIDTH = 376;

const FloatingVoiceIsland = ({ state, audioLevel }) => {
  const isRecording = state === "recording";
  const isProcessing = state === "processing";

  return (
    <span className={`voice-control-island voice-control-island--${state}`} aria-hidden="true">
      <AudioLevelBars
        audioLevel={isRecording ? audioLevel : 0}
        active={isRecording}
        processing={isProcessing}
      />
    </span>
  );
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const { toast, dismiss, toastCount, toasts, pauseTimer, resumeTimer } = useToast();
  // The newest notice morphs the dictation control into a wide card.
  const notice = toasts.length > 0 ? toasts[toasts.length - 1] : null;
  const noticeExpanded = Boolean(notice) && !notice.isExiting;
  const noticeRef = useRef(null);
  const [noticeHeight, setNoticeHeight] = useState(0);
  useLayoutEffect(() => {
    if (!noticeRef.current) return undefined;
    const element = noticeRef.current;
    const measure = () => setNoticeHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notice?.id]);
  const { t } = useTranslation();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const prevAutoHideRef = useRef(floatingIconAutoHide);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    // Main process captures target PID when enabling interactivity.
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const showGpuFallbackToast = () => {
      toast({
        title: t("app.toasts.gpuFallback.title"),
        description: t("app.toasts.gpuFallback.description"),
        duration: 10000,
      });
    };
    const unsubscribeCudaFallback =
      window.electronAPI?.onCudaFallbackNotification?.(showGpuFallbackToast);
    const unsubscribeGpuFallback =
      window.electronAPI?.onGpuFallbackNotification?.(showGpuFallbackToast);

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `\u201c${w}\u201d`).join(", ");
        let toastId;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          variant: "success",
          duration: 6000,
          action: (
            <button
              onClick={async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) {
                    dismiss(toastId);
                  }
                } catch {
                  // silently fail — word stays in dictionary
                }
              }}
              className="text-2xs font-medium px-2.5 py-1 rounded-sm whitespace-nowrap
                text-emerald-100/90 hover:text-white
                bg-emerald-500/15 hover:bg-emerald-500/25
                border border-emerald-400/20 hover:border-emerald-400/35
                transition-all duration-150"
            >
              {t("app.toasts.undo")}
            </button>
          ),
        });
      }
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeCudaFallback?.();
      unsubscribeGpuFallback?.();
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, setWindowInteractivity]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    micCaptureStatus,
    wasPlaced,
    audioLevel,
    toggleListening,
    cancelRecording,
    cancelProcessing,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
  });

  useEffect(() => {
    if (isCommandMenuOpen && toastCount > 0) {
      window.electronAPI?.resizeMainWindow?.("EXPANDED");
    } else if (isCommandMenuOpen) {
      window.electronAPI?.resizeMainWindow?.("WITH_MENU");
    } else if (toastCount > 0) {
      window.electronAPI?.resizeMainWindow?.("WITH_TOAST");
    } else {
      window.electronAPI?.resizeMainWindow?.("BASE");
    }
  }, [isCommandMenuOpen, toastCount]);

  const captureTargetThenToggle = React.useCallback(async () => {
    try {
      await window.electronAPI?.captureTargetPid?.();
    } catch {
      /* non-fatal — paste path will try again */
    }
    toggleListening();
  }, [toggleListening]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording();
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (floatingIconAutoHide && !isRecording && !isProcessing && toastCount === 0) {
      // Delay briefly so processing can start after recording stops without a flash
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [isRecording, isProcessing, floatingIconAutoHide, toastCount]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        setIsCommandMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (wasPlaced) return "placed";
    if (isHovered && !isRecording && !isProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const micProps = {
    className: `voice-morph__button relative flex h-11 w-[74px] items-center justify-center overflow-visible border-0 bg-transparent p-0 ${
      micState === "processing" || micState === "unavailable"
        ? "cursor-not-allowed"
        : "cursor-pointer"
    }`,
    tooltip:
      micState === "recording"
        ? t("app.mic.recording")
        : micState === "unavailable"
          ? t("app.mic.waitingForMicrophone")
          : micState === "processing"
            ? t("app.mic.processing")
            : micState === "placed"
              ? t("desktop.dictation.ready", { defaultValue: "Ready" })
              : t("app.mic.clickToSpeak"),
  };

  return (
    <div className="dictation-window">
      {/* Voice button - position determined by panelStartPosition setting */}
      <div
        className={`fixed bottom-1 z-50 ${
          panelStartPosition === "bottom-left"
            ? "left-1"
            : panelStartPosition === "center"
              ? "left-1/2 -translate-x-1/2"
              : "right-1"
        }`}
      >
        <div
          className="relative flex items-center gap-2"
          onMouseEnter={() => {
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!isCommandMenuOpen) {
              setWindowInteractivity(false);
            }
          }}
        >
          {(isRecording || isProcessing) && isHovered && (
            <button
              aria-label={
                isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
              }
              onClick={(e) => {
                e.stopPropagation();
                isRecording ? cancelRecording() : cancelProcessing();
              }}
              className="group/cancel w-5 h-5 rounded-full bg-surface-2/90 hover:bg-destructive border border-border hover:border-destructive/70 flex items-center justify-center transition-colors duration-150 shadow-sm backdrop-blur-sm"
            >
              <X
                size={10}
                strokeWidth={2.5}
                className="text-foreground group-hover/cancel:text-destructive-foreground transition-colors duration-150"
              />
            </button>
          )}
          <div
            className="voice-morph"
            data-expanded={noticeExpanded ? "true" : "false"}
            style={
              noticeExpanded
                ? { width: NOTICE_WIDTH, height: Math.max(noticeHeight, ISLAND_HEIGHT) }
                : { width: ISLAND_WIDTH, height: ISLAND_HEIGHT }
            }
          >
            {notice && (
              <div
                ref={noticeRef}
                className="voice-morph__notice"
                style={{ width: NOTICE_WIDTH }}
                aria-hidden={!noticeExpanded}
              >
                <NoticeContent
                  {...notice}
                  onClose={() => dismiss(notice.id)}
                  onPauseTimer={() => pauseTimer(notice.id)}
                  onResumeTimer={(remaining) => resumeTimer(notice.id, remaining)}
                />
              </div>
            )}
            <button
              ref={buttonRef}
              aria-label={micProps.tooltip}
              aria-pressed={micState === "recording"}
              aria-busy={micState === "processing"}
              disabled={micState === "processing"}
              onMouseDown={(e) => {
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                if (!hasDragged && isRecording) {
                  setIsCommandMenuOpen(false);
                  void cancelRecording();
                } else if (!hasDragged && micState !== "processing" && micState !== "unavailable") {
                  setIsCommandMenuOpen(false);
                  void captureTargetThenToggle();
                }
                e.preventDefault();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
              onFocus={() => setIsHovered(true)}
              onBlur={() => setIsHovered(false)}
              className={micProps.className}
              style={{
                ...micProps.style,
                cursor:
                  micState === "processing"
                    ? "not-allowed !important"
                    : isDragging
                      ? "grabbing !important"
                      : "pointer !important",
                transition:
                  "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.25s ease-out",
              }}
            >
              <FloatingVoiceIsland state={micState} audioLevel={audioLevel} />
              <span className="sr-only">{micProps.tooltip}</span>
            </button>
          </div>
          {isCommandMenuOpen && (
            <div
              ref={commandMenuRef}
              className="voice-control-menu"
              role="menu"
              aria-label={t("app.commandMenu.actions", { defaultValue: "VoiceLab actions" })}
              onMouseEnter={() => {
                setWindowInteractivity(true);
              }}
              onMouseLeave={() => {
                if (!isHovered) {
                  setWindowInteractivity(false);
                }
              }}
            >
              <button
                type="button"
                className="voice-control-menu__action voice-control-menu__action--close"
                role="menuitem"
                aria-label={t("app.commandMenu.closeVoiceLab", {
                  defaultValue: "Close VoiceLab",
                })}
                title={t("app.commandMenu.closeVoiceLab", { defaultValue: "Close VoiceLab" })}
                onClick={() => {
                  setIsCommandMenuOpen(false);
                  void window.electronAPI.quitApp?.();
                }}
              >
                <X size={14} strokeWidth={2.25} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="voice-control-menu__action"
                role="menuitem"
                aria-label={t("app.commandMenu.hideForNow")}
                title={t("app.commandMenu.hideForNow")}
                onClick={() => {
                  setIsCommandMenuOpen(false);
                  setWindowInteractivity(false);
                  handleClose();
                }}
              >
                <Minus size={16} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
