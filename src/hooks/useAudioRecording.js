import { createElement, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { writeTextToClipboard } from "../utils/writeClipboard";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { expandSnippets } from "../utils/snippets";
import {
  getRecordingErrorTitle,
  getRecordingErrorDescription,
  getRecordingRecoveryAction,
  getRecordingRecoveryActionLabel,
} from "../utils/recordingErrors";
import { isAccessibilitySkipped } from "../utils/permissions";
import { signInWithSocial } from "../lib/auth";

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [micCaptureStatus, setMicCaptureStatus] = useState("inactive");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [wasPlaced, setWasPlaced] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const pendingStartActionRef = useRef(null);
  const stopLockRef = useRef(false);
  const wasRecordingRef = useRef(false);
  const wasMicUnavailableRef = useRef(false);
  const placedTimerRef = useRef(null);
  const { onToggle } = options;

  const performStartRecording = useCallback(
    async ({ voiceAgentRequested = false, translationRequested = false } = {}) => {
      if (startLockRef.current) return false;
      startLockRef.current = true;
      pendingStartActionRef.current = null;
      const manager = audioManagerRef.current;
      try {
        if (!manager) return false;

        const currentState = manager.getState();
        if (currentState.isRecording || currentState.isProcessing) return false;

        manager.setVoiceAgentRequested(voiceAgentRequested);
        manager.setTranslationRequested(translationRequested);

        await playStartCue();
        if (pendingStartActionRef.current || audioManagerRef.current !== manager) return false;
        const didStart = await manager.startRecording();
        if (audioManagerRef.current !== manager) {
          manager.cleanup();
          return false;
        }
        if (didStart && pendingStartActionRef.current) {
          if (pendingStartActionRef.current === "cancel") manager.cancelRecording();
          else manager.stopRecording();
          return false;
        }

        // A quick tap can end the recording inside the start call itself (deferred
        // streaming stop) — don't pause media for a recording that already ended. See #1060.
        if (didStart && manager.getState().isRecording) {
          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.pauseMediaPlayback?.();
          }
          window.electronAPI?.registerCancelHotkey?.("Escape");
        }

        return didStart;
      } finally {
        startLockRef.current = false;
      }
    },
    []
  );

  const performStopRecording = useCallback(async () => {
    if (startLockRef.current) {
      if (pendingStartActionRef.current !== "cancel") pendingStartActionRef.current = "stop";
      return true;
    }
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      window.electronAPI?.unregisterCancelHotkey?.();

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    const manager = new AudioManager();
    audioManagerRef.current = manager;

    manager.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, micCaptureStatus }) => {
        if (isRecording || isProcessing) {
          setWasPlaced(false);
          if (placedTimerRef.current) clearTimeout(placedTimerRef.current);
        }
        if (!isRecording) {
          window.electronAPI?.unregisterCancelHotkey?.();
          // Resume media the instant recording ends, not after transcription.
          if (wasRecordingRef.current && getSettings().pauseMediaOnDictation) {
            window.electronAPI?.resumeMediaPlayback?.();
          }
        }
        wasRecordingRef.current = isRecording;
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (micCaptureStatus) {
          setMicCaptureStatus(micCaptureStatus);
          const unavailable = micCaptureStatus === "unavailable";
          if (unavailable && !wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = true;
            toast({
              title: t("hooks.audioRecording.micDisconnected.title"),
              description: t("hooks.audioRecording.micDisconnected.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "active" && wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = false;
            toast({
              title: t("hooks.audioRecording.micRestored.title"),
              description: t("hooks.audioRecording.micRestored.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "inactive") {
            wasMicUnavailableRef.current = false;
          }
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        if (error?.title !== "Paste Error") {
          window.electronAPI?.hideDictationPreview?.();
        }
        if (error?.code === "INSUFFICIENT_CREDITS") {
          window.electronAPI?.notifyLimitReached?.({
            availableCredits: error.available_credits,
            requiredCredits: error.required_credits,
          });
          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.resumeMediaPlayback?.();
          }
          return;
        }
        const title = getRecordingErrorTitle(error, t);
        const description = getRecordingErrorDescription(error, t);
        const recovery =
          error?.code === "CONCURRENCY_LIMIT" && error?.retryAfterSeconds
            ? null
            : getRecordingRecoveryAction(error?.code);
        const recoveryAction = recovery
          ? createElement(
              "button",
              {
                type: "button",
                className:
                  "rounded-md border border-current/20 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-white/10",
                onClick: async () => {
                  if (recovery === "auth") {
                    const result = await signInWithSocial("google");
                    if (result.error) {
                      toast({
                        title: t("auth.desktopFailed"),
                        description: t("auth.desktopBrowserHint"),
                        variant: "destructive",
                      });
                    }
                  } else if (recovery === "billing") {
                    void window.electronAPI?.openVoiceLabBilling?.("dictate");
                  } else if (recovery === "permission") {
                    void window.electronAPI?.openAccessibilitySettings?.();
                  } else if (recovery === "retry") {
                    void audioManagerRef.current?.retryLastCloudTranscription();
                  }
                },
              },
              getRecordingRecoveryActionLabel(recovery)
            )
          : undefined;
        toast({
          title,
          description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
          action: recoveryAction,
        });
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onAudioLevel: (level) => {
        setAudioLevel(level);
      },
      onTranscriptionComplete: async (result) => {
        const generation = manager._processingGeneration;
        const isCurrent = () =>
          audioManagerRef.current === manager &&
          !manager._disposed &&
          manager._processingGeneration === generation;
        if (!isCurrent()) return;
        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            window.electronAPI?.hideDictationPreview?.();
            toast({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
              variant: "default",
            });
            return;
          }

          result.text = expandSnippets(result.text, getSettings().snippets);

          setTranscript(result.text);
          window.electronAPI?.completeDictationPreview?.({ text: result.text });

          if (result.warning) {
            toast({
              title: t("hooks.audioRecording.partialTranscription.title"),
              description: t("hooks.audioRecording.partialTranscription.description"),
              variant: "default",
            });
          }

          const isStreaming = result.source?.includes("streaming");
          const { autoPasteEnabled } = getSettings();
          let textWasPlaced = false;

          if (autoPasteEnabled) {
            const pasteStart = performance.now();
            textWasPlaced = await manager.safePaste(result.text, {
              ...(isStreaming ? { fromStreaming: true } : {}),
              // Pasting writes this exact final text to the system clipboard first.
              // Keep it there after the native paste so it is immediately available
              // for a manual paste too.
              restoreClipboard: false,
              allowClipboardFallback: isAccessibilitySkipped(),
            });
            logger.info(
              "Paste timing",
              {
                pasteMs: Math.round(performance.now() - pasteStart),
                source: result.source,
                textLength: result.text.length,
              },
              "streaming"
            );
          } else {
            // Dictation is always useful as a pasteable result, even when automatic
            // insertion is turned off.
            await writeTextToClipboard(result.text);
          }

          if (!isCurrent()) return;
          await manager.saveTranscription(result.text, result.rawText ?? result.text, {
            accountId: result.accountId,
            clientTranscriptionId: result.clientTranscriptionId,
            desktopTranscriptionId: result.desktopTranscriptionId,
            desktopRevision: result.desktopRevision,
            desktopAudioAvailable: result.desktopAudioAvailable === true,
          });
          if (!isCurrent()) return;
          if (textWasPlaced) {
            setWasPlaced(true);
            if (placedTimerRef.current) clearTimeout(placedTimerRef.current);
            placedTimerRef.current = setTimeout(() => setWasPlaced(false), 1400);
          }
        }
      },
      onTranslationFallback: ({ reason }) => {
        // Fail-open: the raw text was still pasted; the toast removes the silence.
        toast({
          title:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableTitle")
              : t("hooks.audioRecording.translationFallback.failedTitle"),
          description:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableDescription")
              : t("hooks.audioRecording.translationFallback.failedDescription"),
          variant: "default",
        });
      },
    });

    audioManagerRef.current.setContext("dictation");

    const handleToggle = async ({
      voiceAgentRequested = false,
      translationRequested = false,
    } = {}) => {
      if (!audioManagerRef.current) return;
      // Lazily warm the mic driver on first dictation use, not at launch. See #871.
      audioManagerRef.current.warmupMicDriver?.();
      const currentState = audioManagerRef.current.getState();

      if (startLockRef.current) {
        await performStopRecording();
      } else if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording({ voiceAgentRequested, translationRequested });
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      audioManagerRef.current?.warmupMicDriver?.();
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeVoiceAgentToggle = window.electronAPI.onToggleVoiceAgent?.(() => {
      handleToggle({ voiceAgentRequested: true });
      onToggle?.();
    });

    const disposeTranslationToggle = window.electronAPI.onToggleTranslation?.(() => {
      handleToggle({ translationRequested: true });
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeVoiceAgentToggle?.();
      disposeTranslationToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      if (placedTimerRef.current) clearTimeout(placedTimerRef.current);
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
        audioManagerRef.current = null;
      }
    };
  }, [toast, onToggle, performStartRecording, performStopRecording, t]);

  const cancelRecording = useCallback(async () => {
    if (startLockRef.current) {
      pendingStartActionRef.current = "cancel";
      return true;
    }
    if (audioManagerRef.current) {
      window.electronAPI?.unregisterCancelHotkey?.();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (startLockRef.current) {
      await performStopRecording();
    } else if (!isRecording && !isProcessing) {
      await performStartRecording();
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    micCaptureStatus,
    transcript,
    partialTranscript,
    wasPlaced,
    audioLevel,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
