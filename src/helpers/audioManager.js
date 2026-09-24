import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import {
  isSecureEndpoint,
  isAzureOpenAIEndpoint,
  buildAzureTranscriptionUrl,
} from "../utils/urlUtils";
import { withSessionRefresh } from "../lib/auth";
import { getBaseLanguageCode, getLanguageLabel } from "../utils/languageSupport";
import {
  createLocalSpeechGateState,
  getLocalSpeechGateDecision,
  recordLocalSpeechWindow,
} from "./localSpeechGate";
import { reacquireIfDead } from "./micTrackHealth";
import { ActiveMicRecoveryController } from "./activeMicRecovery";
import { followsSystemDefaultMic, reconcileSavedMicSelection } from "./micSelectionRecovery";
import { isStaleDeviceError } from "./staleMicDevice";
import { shouldSaveDiscardedRecording } from "./discardedRecording";
import {
  getSettings,
  getEffectiveCleanupModel,
  isCloudCleanupMode,
  isCloudDictationAgentMode,
  isCloudTranslationMode,
} from "../stores/settingsStore";
import { recordCleanupFailure } from "../stores/cleanupFailureStore";
import {
  getBatchTranscriptionModel,
  getTranscriptionProvider,
  isOnlineParakeetModel,
} from "../models/ModelRegistry";
import { shouldSkipTranscriptionApiKey } from "./transcriptionAuth";
import {
  isSelfHostedTranscription,
  resolveSelfHostedTranscriptionModel,
} from "./selfHostedTranscription";
import { resolveStreamingFallbackTarget } from "./transcriptionFallback";
import {
  executeTranslationChain,
  resolveTranslatedText,
  shouldRunTranslateStep,
} from "./translationChain";
import { detectAgentName } from "../config/agentDetection";
import {
  resolveDictationRouteKind,
  resolveDictationAgentReachability,
  resolveDictationTranslationReachability,
} from "./dictationRouting";
import { resolvePrompt } from "../config/prompts";
import { syncService } from "../services/SyncService.js";
import { evaluateFinishedRecording } from "./recordingValidation";
import { isEmptyRecording } from "./recordingGuard";
import { matchesDictionaryPrompt } from "../utils/dictionaryEchoFilter.js";
import { getDictionaryHintWords } from "../utils/snippets";
import { mergePcm16WavBuffers, PCM_WAV_RECORDING_FORMAT, PcmWavRecorder } from "./pcmWavRecorder";

const REASONING_CACHE_TTL = 30000; // 30 seconds
// Failure detector only: fires when the worklet or audio graph is dead and never flushes.
const PREVIEW_FLUSH_WATCHDOG_MS = 1000;
const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
const VOICELAB_PROVIDER = "voicelab";

function canonicalProviderName(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["openwhispr", "openwhispr-cloud", "voicelab-cloud"].includes(provider)
    ? VOICELAB_PROVIDER
    : provider;
}

function dictationAgentReachable(settings) {
  return resolveDictationAgentReachability({
    useDictationAgent: settings.useDictationAgent,
    dictationAgentModel: settings.dictationAgentModel,
    isCloudAgent: isCloudDictationAgentMode(),
    isSelfHostedAgent:
      settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim(),
  });
}

function translationChainReachable(settings) {
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  return resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation: isCloudTranslationMode(),
    isSelfHostedTranslation,
  });
}

function resolveReasoningRoute(
  text,
  settings,
  agentName,
  voiceAgentRequested,
  translationRequested
) {
  const cleanupReachable =
    !!settings.useCleanupModel && (!!settings.cleanupModel?.trim() || isCloudCleanupMode());
  const agentModel = settings.dictationAgentModel?.trim() || "";
  const isCloudAgent = isCloudDictationAgentMode();
  const isSelfHostedAgent =
    settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();
  const agentReachable = resolveDictationAgentReachability({
    useDictationAgent: settings.useDictationAgent,
    dictationAgentModel: agentModel,
    isCloudAgent,
    isSelfHostedAgent,
  });

  const isCloudTranslation = isCloudTranslationMode();
  const isSelfHostedTranslation =
    settings.translationMode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  const translationReachable = resolveDictationTranslationReachability({
    useDictationTranslation: settings.useDictationTranslation,
    translationTargetLanguage: settings.translationTargetLanguage,
    translationModel: settings.translationModel,
    isCloudTranslation,
    isSelfHostedTranslation,
  });

  const kind = resolveDictationRouteKind({
    cleanupReachable,
    agentReachable,
    agentInvoked: !!agentName && detectAgentName(text, agentName),
    voiceAgentRequested,
    translationRequested,
    translationReachable,
  });
  if (translationRequested && kind !== "translation") {
    logger.warn(
      "Translation requested but unreachable, falling back",
      {
        kind,
        useDictationTranslation: settings.useDictationTranslation,
        hasTarget: !!settings.translationTargetLanguage?.trim(),
      },
      "transcription"
    );
  }
  if (kind === "translation") {
    const provider = isCloudTranslation
      ? VOICELAB_PROVIDER
      : settings.translationProvider?.trim() || undefined;
    const isCustomTranslation = settings.translationMode === "providers" && provider === "custom";
    return {
      kind: "translation",
      model: settings.translationModel?.trim() || "",
      cleanupReachable,
      cleanupConfig: { disableThinking: settings.cleanupDisableThinking },
      config: {
        provider,
        language: settings.translationTargetLanguage,
        lanUrl: isSelfHostedTranslation ? settings.translationRemoteUrl : undefined,
        baseUrl: isCustomTranslation ? settings.translationCloudBaseUrl || undefined : undefined,
        customApiKey:
          isCustomTranslation || isSelfHostedTranslation
            ? settings.translationCustomApiKey || undefined
            : undefined,
        disableThinking: settings.translationDisableThinking,
        systemPrompt: resolvePrompt("translate", {
          agentName,
          targetLanguageLabel: getLanguageLabel(settings.translationTargetLanguage),
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "agent") {
    const provider = isCloudAgent
      ? VOICELAB_PROVIDER
      : settings.dictationAgentProvider?.trim() || undefined;
    const isCustomAgent = settings.dictationAgentMode === "providers" && provider === "custom";
    return {
      kind: "agent",
      model: agentModel,
      config: {
        provider,
        lanUrl: isSelfHostedAgent ? settings.dictationAgentRemoteUrl : undefined,
        baseUrl: isCustomAgent ? settings.dictationAgentCloudBaseUrl || undefined : undefined,
        customApiKey:
          isCustomAgent || isSelfHostedAgent
            ? settings.dictationAgentCustomApiKey || undefined
            : undefined,
        disableThinking: settings.dictationAgentDisableThinking,
        systemPrompt: resolvePrompt("dictationAgent", {
          agentName,
          language: settings.preferredLanguage,
          customDictionary: getDictionaryHintWords(settings),
          uiLanguage: settings.uiLanguage,
        }),
      },
    };
  }
  if (kind === "cleanup") {
    return {
      kind: "cleanup",
      config: { disableThinking: settings.cleanupDisableThinking },
    };
  }
  return { kind: "skip" };
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
  xai: "your_xai_api_key_here",
  mistral: "your_mistral_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

const STREAMING_PROVIDERS = {
  deepgram: {
    warmup: (opts) => window.electronAPI.deepgramStreamingWarmup(opts),
    start: (opts) => window.electronAPI.deepgramStreamingStart(opts),
    send: (buf) => window.electronAPI.deepgramStreamingSend(buf),
    finalize: () => window.electronAPI.deepgramStreamingFinalize(),
    stop: () => window.electronAPI.deepgramStreamingStop(),
    status: () => window.electronAPI.deepgramStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onDeepgramPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onDeepgramFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onDeepgramError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDeepgramSessionEnd(cb),
  },
  assemblyai: {
    warmup: (opts) => window.electronAPI.assemblyAiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.assemblyAiStreamingStart(opts),
    send: (buf) => window.electronAPI.assemblyAiStreamingSend(buf),
    finalize: () => window.electronAPI.assemblyAiStreamingForceEndpoint(),
    stop: () => window.electronAPI.assemblyAiStreamingStop(),
    status: () => window.electronAPI.assemblyAiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onAssemblyAiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onAssemblyAiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onAssemblyAiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onAssemblyAiSessionEnd(cb),
  },
  "openai-realtime": {
    warmup: (opts) => window.electronAPI.dictationRealtimeWarmup(opts),
    start: (opts) => window.electronAPI.dictationRealtimeStart(opts),
    send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
    stop: () => window.electronAPI.dictationRealtimeStop(),
    onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
    onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
    onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
  },
  corti: {
    warmup: (opts) => window.electronAPI.cortiStreamingWarmup(opts),
    start: (opts) => window.electronAPI.cortiStreamingStart(opts),
    send: (buf) => window.electronAPI.cortiStreamingSend(buf),
    finalize: () => window.electronAPI.cortiStreamingFinalize(),
    stop: () => window.electronAPI.cortiStreamingStop(),
    status: () => window.electronAPI.cortiStreamingStatus(),
    onPartial: (cb) => window.electronAPI.onCortiPartialTranscript(cb),
    onFinal: (cb) => window.electronAPI.onCortiFinalTranscript(cb),
    onError: (cb) => window.electronAPI.onCortiError(cb),
    onSessionEnd: (cb) => window.electronAPI.onCortiSessionEnd(cb),
  },
  "tinfoil-realtime": {
    warmup: (opts) =>
      window.electronAPI.dictationRealtimeWarmup({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
    start: (opts) =>
      window.electronAPI.dictationRealtimeStart({
        ...opts,
        provider: "tinfoil-realtime",
        preview: true,
      }),
    send: (buf) => window.electronAPI.dictationRealtimeSend(buf),
    stop: () => window.electronAPI.dictationRealtimeStop(),
    onPartial: (cb) => window.electronAPI.onDictationRealtimePartial(cb),
    onFinal: (cb) => window.electronAPI.onDictationRealtimeFinal(cb),
    onError: (cb) => window.electronAPI.onDictationRealtimeError(cb),
    onSessionEnd: (cb) => window.electronAPI.onDictationRealtimeSessionEnd(cb),
  },
};

class AudioManager {
  constructor() {
    this.wavRecorder = null;
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onAudioLevel = null;
    this.micCaptureStatus = "inactive";

    // Invalidate the pinned mic device when the OS adds/removes/suspends inputs.
    // Otherwise wake-after-idle keeps requesting a stale deviceId that yields silence.
    this._onDeviceChange = () => {
      this.cachedMicDeviceId = null;
      this.validatedSelectedMicDeviceId = null;
      this.micDriverWarmedUp = false;
      this.rejectedMicDeviceId = null;
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.isStreaming = false;
    this.streamingAudioContext = null;
    this.streamingSource = null;
    this.streamingProcessor = null;
    this.streamingStream = null;
    this.streamingLevelAnalyser = null;
    this.streamingLevelSource = null;
    this.streamingLevelInterval = null;
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    this.streamingTextDebounce = null;
    this.cachedMicDeviceId = null;
    this.validatedSelectedMicDeviceId = null;
    this.rejectedMicDeviceId = null;
    this.persistentAudioContext = null;
    this.workletModuleLoaded = false;
    this.workletBlobUrl = null;
    this.streamingStartInProgress = false;
    this.stopRequestedDuringStreamingStart = false;
    this.streamingFallbackRecorder = null;
    this.skipReasoning = false;
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.context = "dictation";
    this.sttConfig = null;
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    this.lastRetryMetadata = null;
    this._activeCloudRequestId = null;
    this._processingGeneration = 0;
    this._recordingGeneration = 0;
    this._recordingAccountId = null;
    this._disposed = false;
    this._localSpeechGateState = null;
    this._streamingCommitActive = false;
    this._previewFlushResolve = null;
    this._batchSegments = [];
    this._rotatingBatchRecorder = null;
    this._batchFinalizingRecorder = null;
    this._stopRequestedDuringMicRecovery = false;
    this._cancelRequestedDuringMicRecovery = false;
    this._streamingFallbackSegments = [];
    this._streamingMicSwapPromise = null;
    this.micRecovery = new ActiveMicRecoveryController({
      mediaDevices: navigator.mediaDevices,
      acquire: async () => {
        try {
          const constraints = await this.getAudioConstraints();
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
          logger.debug(
            "Preferred mic unavailable during recovery, falling back to default",
            { error: error.message },
            "audio"
          );
          const fallback = await this.getAudioConstraints(true);
          return navigator.mediaDevices.getUserMedia(fallback);
        }
      },
      onRecovered: (replacement, previous) => this.replaceActiveMic(replacement, previous),
      onStatusChange: (status) => this.setMicCaptureStatus(status),
    });
  }

  getWorkletBlobUrl() {
    if (this.workletBlobUrl) return this.workletBlobUrl;
    const code = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this.port.postMessage("flushed");
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-streaming-processor", PCMStreamingProcessor);
`;
    this.workletBlobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return this.workletBlobUrl;
  }

  getCustomDictionaryPrompt() {
    const words = getDictionaryHintWords(getSettings());
    return words.length > 0 ? words.join(", ") : null;
  }

  isDictionaryEcho(text) {
    return matchesDictionaryPrompt(text, this.getCustomDictionaryPrompt());
  }

  setCallbacks({
    onStateChange,
    onError,
    onTranscriptionComplete,
    onPartialTranscript,
    onAudioLevel,
    onStreamingCommit,
    onTranslationFallback,
  }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    this.onPartialTranscript = onPartialTranscript;
    this.onAudioLevel = onAudioLevel;
    this.onStreamingCommit = onStreamingCommit;
    this.onTranslationFallback = onTranslationFallback;
  }

  // Fail-open: translation degraded/failed but raw text is still pasted. Surface why.
  notifyTranslationFallback(reason) {
    this.onTranslationFallback?.({ reason });
  }

  emitAudioLevel(rms = 0, peak = 0) {
    // Use the measured waveform, with a small gain so normal speech is visible
    // without turning room noise into a busy animation.
    const measured = Math.max(rms * 9, peak * 0.6);
    const level = Math.min(1, Math.max(0, (measured - 0.02) / 0.58));
    this.onAudioLevel?.(level);
  }

  setMicCaptureStatus(status) {
    if (this.micCaptureStatus === status) return;
    this.micCaptureStatus = status;
    this.onStateChange?.({
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      micCaptureStatus: status,
    });
  }

  async beginMicRecovery(stream) {
    // A stop/cancel can land during the awaits between recorder start and this
    // call; never arm recovery for a recording that already ended.
    if (!this.isRecording) return;
    await this.micRecovery.start(stream, {
      followDefault: followsSystemDefaultMic(getSettings()),
    });
  }

  async replaceActiveMic(replacement, previous) {
    if (!this.isRecording) throw new Error("Recording is no longer active");
    if (this.isStreaming) {
      await this.replaceStreamingMic(replacement, previous);
    } else {
      await this.replaceBatchMic(replacement, previous);
    }
  }

  async mergeRecordedSegments(segments) {
    // A WAV containing only its 44-byte header carries no PCM frames.
    const usable = segments.filter((segment) => segment && !isEmptyRecording(segment.size));
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];
    const merged = mergePcm16WavBuffers(
      await Promise.all(usable.map((segment) => segment.arrayBuffer()))
    );
    return new Blob([merged], { type: PCM_WAV_RECORDING_FORMAT.mimeType });
  }

  getLargestRecordedSegment(segments) {
    return segments
      .filter((segment) => segment && !isEmptyRecording(segment.size))
      .reduce(
        (largest, segment) => (segment.size > (largest?.size || 0) ? segment : largest),
        null
      );
  }

  setSkipReasoning(skip) {
    this.skipReasoning = skip;
  }

  setVoiceAgentRequested(requested) {
    this.voiceAgentRequested = requested;
  }

  setTranslationRequested(requested) {
    this.translationRequested = requested;
  }

  // In translation mode the STT hint is the configured source language, not
  // the UI-wide preferred language; "auto" keeps whisper auto-detection.
  getEffectiveSttLanguage(settings) {
    if (this.translationRequested) {
      return settings.translationSourceLanguage || "auto";
    }
    return settings.preferredLanguage;
  }

  setContext(context) {
    this.context = context;
  }

  setSttConfig(config) {
    this.sttConfig = config;
  }

  getStreamingProvider() {
    const fallback = this.context === "notes" ? "deepgram" : "openai-realtime";
    return STREAMING_PROVIDERS[this.getStreamingProviderName()] || STREAMING_PROVIDERS[fallback];
  }

  getStreamingProviderName() {
    const s = getSettings();
    if (s.cloudTranscriptionProvider === "tinfoil") {
      return "tinfoil-realtime";
    }
    if (s.cloudTranscriptionProvider === "corti" && s.cloudTranscriptionMode === "byok") {
      return "corti";
    }
    if (REALTIME_MODELS.has(s.cloudTranscriptionModel)) {
      return "openai-realtime";
    }
    const defaultProvider = this.context === "notes" ? "deepgram" : "openai-realtime";
    return this.sttConfig?.streamingProvider || defaultProvider;
  }

  async getAudioConstraints(forceDefaultMic = false) {
    const {
      preferBuiltInMic: preferBuiltIn,
      selectedMicDeviceId: selectedDeviceId,
      selectedMicDeviceLabel: selectedDeviceLabel,
    } = getSettings();

    // All browser audio processing disabled to avoid OS-level side-effects.
    // AGC off: Chromium's AGC on Windows mutates the system mic volume via WASAPI (#476).
    // Echo cancellation and noise suppression off to avoid latency and speech distortion.
    // Stereo recording required — mono WebM breaks silence detection on Linux/PipeWire (#472).
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };

    // Pinned device was unavailable (Chromium rotates IDs / device unplugged); fall back to the
    // system default for this capture without discarding the saved preference. See #900.
    if (forceDefaultMic) {
      logger.debug("Using default microphone (pinned device unavailable)", {}, "audio");
      return { audio: noProcessing };
    }

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        // The device was already proven silent this session; don't pin it again.
        if (this.cachedMicDeviceId === this.rejectedMicDeviceId) {
          logger.debug(
            "Skipping cached microphone (delivered no audio)",
            { deviceId: this.cachedMicDeviceId },
            "audio"
          );
          return { audio: noProcessing };
        }

        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          // Leave it uncached so a later devicechange can re-resolve it cleanly.
          if (builtInMic.deviceId === this.rejectedMicDeviceId) {
            logger.debug(
              "Skipping built-in microphone (delivered no audio)",
              { deviceId: builtInMic.deviceId, label: builtInMic.label },
              "audio"
            );
            return { audio: noProcessing };
          }

          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId) {
      let resolvedDeviceId = selectedDeviceId;

      if (this.validatedSelectedMicDeviceId !== selectedDeviceId) {
        try {
          const reconciled = await reconcileSavedMicSelection(
            selectedDeviceId,
            selectedDeviceLabel,
            "audio"
          );
          resolvedDeviceId = reconciled.deviceId;

          if (reconciled.resolved) {
            this.validatedSelectedMicDeviceId = resolvedDeviceId;
          } else {
            // Avoid enumerating on every recording while the saved device is
            // unplugged. A devicechange event clears this cache when it returns.
            this.validatedSelectedMicDeviceId = reconciled.labelsAvailable
              ? selectedDeviceId
              : null;
          }
        } catch (error) {
          logger.debug(
            "Failed to reconcile selected microphone",
            { error: error.message },
            "audio"
          );
        }
      }

      if (resolvedDeviceId === this.rejectedMicDeviceId) {
        logger.debug(
          "Skipping selected microphone (delivered no audio)",
          { deviceId: resolvedDeviceId },
          "audio"
        );
        return { audio: noProcessing };
      }

      logger.debug("Using selected microphone", { deviceId: resolvedDeviceId }, "audio");
      return { audio: { deviceId: { exact: resolvedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  async cacheMicrophoneDeviceId() {
    if (this.cachedMicDeviceId) return; // Already cached

    if (!getSettings().preferBuiltInMic) return; // Only needed for built-in mic detection

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));
      if (builtInMic) {
        this.cachedMicDeviceId = builtInMic.deviceId;
        logger.debug("Microphone device ID pre-cached", { deviceId: builtInMic.deviceId }, "audio");
      }
    } catch (error) {
      logger.debug("Failed to pre-cache microphone device ID", { error: error.message }, "audio");
    }
  }

  // Briefly acquire and release the mic so the OS audio driver is warm before
  // the first real recording, reducing cold-start empty captures. See #871.
  async warmupMicDriver() {
    if (this.micDriverWarmedUp) return;
    // Skip while a recording is active so we don't double-acquire the mic. See #871.
    if (this.isRecording || this.isProcessing || this.wavRecorder?.state === "recording") return;
    try {
      const constraints = await this.getAudioConstraints();
      const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
      tempStream.getTracks().forEach((track) => track.stop());
      this.micDriverWarmedUp = true;
      logger.debug("Microphone driver pre-warmed", {}, "audio");
    } catch (e) {
      logger.debug("Mic driver warmup failed (non-critical)", { error: e.message }, "audio");
    }
  }

  // Recovers a dead/muted capture: retries the same device, then hops to the OS default,
  // remembering a silent pinned device for the session. Throws MicUnusableError when no
  // input delivers audio. See #1152.
  async acquireHealthyMicStream(rawStream, constraints) {
    const pinnedMicDeviceId = constraints.audio?.deviceId?.exact ?? null;
    let fallbackMicUnusable = false;
    // Keep verifying after a rejection too, otherwise a muted default records silence unnoticed.
    const verifyMic = pinnedMicDeviceId !== null || this.rejectedMicDeviceId !== null;
    const stream = await reacquireIfDead(
      rawStream,
      () => {
        this.cachedMicDeviceId = null;
        return this.getAudioConstraints();
      },
      logger,
      verifyMic
        ? {
            getConstraints: () => this.getAudioConstraints(true),
            onDeviceRejected: () => {
              if (pinnedMicDeviceId) this.rejectedMicDeviceId = pinnedMicDeviceId;
            },
            onFallbackUnusable: () => {
              fallbackMicUnusable = true;
            },
          }
        : null
    );

    if (fallbackMicUnusable) {
      stream.getTracks().forEach((track) => track.stop());
      const micError = new Error("No microphone is delivering audio");
      micError.name = "MicUnusableError";
      throw micError;
    }

    return stream;
  }

  async captureRecordingAccountId() {
    const status = await window.electronAPI?.authGetStatus?.();
    const user = status?.status === "authenticated" ? status.user : null;
    this._recordingAccountId = user
      ? String(user.id ?? user.user_id ?? user.uuid ?? "") || null
      : null;
  }

  async startRecording(forceDefaultMic = false) {
    let micStream = null;
    try {
      if (
        this._disposed ||
        this.isRecording ||
        this.isProcessing ||
        this.wavRecorder?.state === "recording"
      ) {
        return false;
      }

      await this.captureRecordingAccountId();
      const constraints = await this.getAudioConstraints(forceDefaultMic);
      if (this._disposed) return false;
      micStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this._disposed) {
        micStream.getTracks().forEach((track) => track.stop());
        return false;
      }
      micStream = await this.acquireHealthyMicStream(micStream, constraints);
      if (this._disposed) {
        micStream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const audioTrack = micStream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      try {
        this._silenceCtx = new AudioContext();
        if (this._silenceCtx.state === "suspended") {
          // Not awaited — resume() can hang when the output device is wedged.
          this._silenceCtx.resume().catch(() => {});
        }
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        this._silenceSource = this._silenceCtx.createMediaStreamSource(micStream);
        this._silenceSource.connect(this._silenceAnalyser);
        this._localSpeechGateState = createLocalSpeechGateState();
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          // A stalled context reads flat silence; recording no windows fails the gate open.
          if (this._silenceCtx?.state !== "running") return;
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          recordLocalSpeechWindow(this._localSpeechGateState, rms, peak);
          this.emitAudioLevel(rms, peak);
        }, 100);
      } catch (e) {
        logger.warn("Audio level gate setup failed, skipping", { error: e.message }, "audio");
        this._localSpeechGateState = null;
      }

      this._batchSegments = [];
      this._recordingGeneration += 1;
      this._stopRequestedDuringMicRecovery = false;
      this._cancelRequestedDuringMicRecovery = false;
      this._receivedAudioData = false;
      this.recordingStartTime = Date.now();
      await this.createBatchRecorder(micStream);
      if (this._disposed) {
        await this.stopBatchRecorder(this.wavRecorder);
        this.wavRecorder = null;
        this.teardownSpeechGate();
        return false;
      }
      this.isRecording = true;
      this.onStateChange?.({
        isRecording: true,
        isProcessing: false,
        micCaptureStatus: "active",
      });

      this._streamingCommitActive = false;

      await this.beginMicRecovery(micStream);

      return true;
    } catch (error) {
      micStream?.getTracks().forEach((track) => track.stop());
      this.teardownSpeechGate();
      if (this._disposed) return false;
      if (isStaleDeviceError(error) && !forceDefaultMic) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn("Pinned microphone unavailable, retrying on default mic", {}, "audio");
        this.cachedMicDeviceId = null;
        return this.startRecording(true);
      }

      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  async createBatchRecorder(micStream) {
    const recorder = new PcmWavRecorder({
      sampleRate: PCM_WAV_RECORDING_FORMAT.sampleRate,
      onAudioData: () => {
        this._receivedAudioData = true;
      },
    });
    await recorder.start(micStream);
    this.wavRecorder = recorder;
    return recorder;
  }

  async stopBatchRecorder(recorder) {
    const wavBuffer = await recorder.stop();
    recorder.stream?.getTracks().forEach((track) => track.stop());
    return new Blob([wavBuffer], { type: PCM_WAV_RECORDING_FORMAT.mimeType });
  }

  async finishBatchRecorder(recorder) {
    if (this._batchFinalizingRecorder === recorder) return;
    const generation = this._recordingGeneration;
    this._batchFinalizingRecorder = recorder;
    try {
      const segment = await this.stopBatchRecorder(recorder);
      if (this._disposed || generation !== this._recordingGeneration) return;
      if (this.wavRecorder === recorder) this.wavRecorder = null;
      await this.finalizeBatchRecording(segment);
    } catch (error) {
      if (this._disposed || generation !== this._recordingGeneration) return;
      logger.error("Failed to finalize WAV recording", { error: error.message }, "audio");
      if (this.wavRecorder === recorder) this.wavRecorder = null;
      await this.finalizeBatchRecording(null);
    } finally {
      if (this._batchFinalizingRecorder === recorder) this._batchFinalizingRecorder = null;
    }
  }

  async finalizeBatchRecording(finalSegment) {
    if (this._disposed) return;
    const generation = ++this._processingGeneration;
    this.micRecovery.stop();
    this.teardownSpeechGate();
    const previewStopPromise = this.cleanupPreview({
      showCleanup: this.shouldShowPreviewCleanupState(),
    });
    this.isRecording = false;
    this.isProcessing = true;
    this.onStateChange?.({
      isRecording: false,
      isProcessing: true,
      micCaptureStatus: "inactive",
    });

    const segments = finalSegment ? [...this._batchSegments, finalSegment] : this._batchSegments;
    this._batchSegments = [];
    const segmentsCount = segments.filter((segment) => segment?.size > 0).length;
    let audioBlob = null;
    try {
      audioBlob = await this.mergeRecordedSegments(segments);
    } catch (error) {
      if (generation !== this._processingGeneration || this._disposed) return;
      logger.error("Failed to assemble recovered recording", { error: error.message }, "audio");
      // Salvage the largest segment rather than dropping the whole recording.
      audioBlob = this.getLargestRecordedSegment(segments);
    }
    if (generation !== this._processingGeneration || this._disposed) return;
    audioBlob = audioBlob || new Blob([], { type: PCM_WAV_RECORDING_FORMAT.mimeType });
    this.lastAudioBlob = audioBlob;

    logger.info(
      "Recording stopped",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        segmentsCount,
      },
      "audio"
    );

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;
    this.recordingStartTime = null;
    const recordingCheck = evaluateFinishedRecording({
      blobSize: audioBlob.size,
      receivedAudioData: this._receivedAudioData,
    });
    if (!recordingCheck.usable) {
      logger.info(
        "Dropping degenerate recording before transcription",
        {
          blobSize: audioBlob.size,
          reason: recordingCheck.reason,
          receivedAudioData: this._receivedAudioData,
        },
        "audio"
      );
      this.isProcessing = false;
      this._localSpeechGateState = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    // Non-commit sessions stop concurrently with the decode below.
    const previewStop = this._streamingCommitActive ? await previewStopPromise : null;
    if (generation !== this._processingGeneration || this._disposed) return;
    this._streamingCommitActive = false;

    await this.processAudio(audioBlob, {
      accountId: this._recordingAccountId,
      durationSeconds,
      ...(previewStop?.streamed ? { streamedText: previewStop.text } : {}),
    });
  }

  async replaceBatchMic(replacement) {
    try {
      const recorder = this.wavRecorder;
      if (!recorder) throw new Error("Batch recorder is no longer active");
      this._rotatingBatchRecorder = recorder;
      const segment = await this.stopBatchRecorder(recorder);
      if (!isEmptyRecording(segment.size)) this._batchSegments.push(segment);
      if (this.wavRecorder === recorder) this.wavRecorder = null;
      this._rotatingBatchRecorder = null;
      if (!this.isRecording) throw new Error("Recording stopped during microphone recovery");

      this._silenceSource?.disconnect();
      if (this._silenceCtx && this._silenceAnalyser) {
        this._silenceSource = this._silenceCtx.createMediaStreamSource(replacement);
        this._silenceSource.connect(this._silenceAnalyser);
      }
      this._previewSource?.disconnect();
      if (this._previewAudioContext && this._previewProcessor) {
        this._previewSource = this._previewAudioContext.createMediaStreamSource(replacement);
        this._previewSource.connect(this._previewProcessor);
      }
      await this.createBatchRecorder(replacement);
    } finally {
      this._rotatingBatchRecorder = null;
      // Honor a stop/cancel that arrived mid-rotation even when the swap failed —
      // dropping it would leave an unstoppable recording (isRecording stuck true).
      const cancelRequested = this._cancelRequestedDuringMicRecovery;
      const stopRequested = this._stopRequestedDuringMicRecovery;
      this._cancelRequestedDuringMicRecovery = false;
      this._stopRequestedDuringMicRecovery = false;
      if (cancelRequested) this.cancelRecording();
      else if (stopRequested) this.stopRecording();
    }
  }

  stopRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._stopRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.wavRecorder && ["recording", "stopping"].includes(this.wavRecorder.state)) {
      void this.finishBatchRecorder(this.wavRecorder);
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; finalize what
      // was captured instead of leaving the recording unstoppable.
      void this.finalizeBatchRecording(null);
      return true;
    }
    return false;
  }

  teardownSpeechGate() {
    if (this._silenceInterval) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
    this._silenceSource = null;
    this.emitAudioLevel();
  }

  cancelRecording() {
    this.micRecovery.stop();
    if (this._rotatingBatchRecorder) {
      this._cancelRequestedDuringMicRecovery = true;
      return true;
    }
    if (this.wavRecorder && ["recording", "stopping"].includes(this.wavRecorder.state)) {
      const recorder = this.wavRecorder;
      const discarded = this.takeDiscardedBatchSnapshot();
      this.resetDiscardedBatchRecordingState();
      void this.persistDiscardedBatchRecording({ ...discarded, recorder });
      return true;
    }
    if (this.isRecording && !this.isStreaming) {
      // The mic died mid-recovery, so no live recorder exists; discard what was
      // captured instead of leaving the recording uncancelable.
      this.discardBatchRecording();
      return true;
    }
    return false;
  }

  discardBatchRecording() {
    const discarded = this.takeDiscardedBatchSnapshot();
    this.resetDiscardedBatchRecordingState();
    void this.persistDiscardedBatchRecording(discarded);
  }

  takeDiscardedBatchSnapshot() {
    return {
      accountId: this._recordingAccountId,
      durationSeconds: this.recordingStartTime
        ? (Date.now() - this.recordingStartTime) / 1000
        : null,
      segments: [...this._batchSegments],
      recorder: this.wavRecorder,
    };
  }

  resetDiscardedBatchRecordingState() {
    this._recordingGeneration += 1;
    this.teardownSpeechGate();
    this._localSpeechGateState = null;

    this.cleanupPreview({ dismiss: true });
    this.isRecording = false;
    this.isProcessing = false;
    this.wavRecorder = null;
    this._batchSegments = [];
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: false });
  }

  async persistDiscardedBatchRecording({ accountId, durationSeconds, segments, recorder = null }) {
    try {
      const captured = recorder ? await this.stopBatchRecorder(recorder) : null;
      const allSegments = captured ? [...segments, captured] : segments;
      if (!shouldSaveDiscardedRecording(getSettings(), durationSeconds)) return;
      const blob = await this.mergeRecordedSegments(allSegments);
      if (blob) await this.saveDiscardedTranscription(blob, durationSeconds, accountId);
    } catch (error) {
      logger.warn("Failed to save discarded WAV recording", { error: error.message }, "audio");
    }
  }

  cancelProcessing() {
    this._processingGeneration += 1;
    if (this.isProcessing) {
      if (this._activeCloudRequestId) {
        void window.electronAPI?.cancelCloudTranscribe?.(this._activeCloudRequestId);
        this._activeCloudRequestId = null;
      }
      this.isProcessing = false;
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      this.lastRetryMetadata = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      return true;
    }
    if (this.lastAudioBlob && this.lastRetryMetadata) {
      // An explicit cancel after a recoverable failure dismisses the retained
      // retry payload without adding it to workspace history.
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      this.lastRetryMetadata = null;
      return true;
    }
    return false;
  }

  async retryLastCloudTranscription() {
    if (this.isProcessing || !this.lastAudioBlob) return false;
    this.isProcessing = true;
    this.onStateChange?.({ isRecording: false, isProcessing: true });
    await this.processAudio(this.lastAudioBlob, this.lastRetryMetadata || {});
    return true;
  }

  async processAudio(audioBlob, metadata = {}) {
    if (this._disposed) return;
    const generation = ++this._processingGeneration;
    const pipelineStart = performance.now();
    const speechGateDecision = getLocalSpeechGateDecision(this._localSpeechGateState);
    this._localSpeechGateState = null;

    if (speechGateDecision.skip) {
      logger.info(
        "Speech gate skipped transcription",
        {
          reason: speechGateDecision.reason,
          peakRms: speechGateDecision.peakRms?.toFixed(4),
          peakAmplitude: speechGateDecision.peakAmplitude?.toFixed(4),
          speechWindowCount: speechGateDecision.speechWindowCount,
          maxConsecutiveSpeechWindows: speechGateDecision.maxConsecutiveSpeechWindows,
        },
        "audio"
      );
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }

    try {
      const activeModel = "voicelab-cloud";
      const mode = "cloud";
      const result = await this.processWithVoiceLabCloud(audioBlob, metadata, generation);
      if (generation !== this._processingGeneration || !this.isProcessing) return;
      this.lastRetryMetadata = null;
      this.lastAudioMetadata = {
        accountId: result?.accountId ?? metadata.accountId ?? null,
        durationMs: metadata?.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : Math.round(performance.now() - pipelineStart),
        provider: result?.source || mode,
        model: activeModel || null,
        desktopTranscriptionId: result?.desktopTranscriptionId ?? null,
        desktopRevision: result?.desktopRevision ?? null,
        desktopAudioAvailable: result?.desktopAudioAvailable === true,
      };
      await this.onTranscriptionComplete?.(result);
      if (generation !== this._processingGeneration) return;
      if (result?.source === VOICELAB_PROVIDER && !result?.text?.trim()) {
        // A final cloud response with no text has no history-save path. Release
        // the recording immediately instead of retaining it indefinitely.
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
      if (result?.source === VOICELAB_PROVIDER) {
        window.dispatchEvent(
          new CustomEvent("usage-changed", {
            detail: { usage: result?.usage ?? null },
          })
        );
      }
      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);
      logger.info(
        "Pipeline timing",
        {
          mode,
          model: activeModel,
          audioDurationMs: metadata.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null,
          transcriptionProcessingDurationMs:
            result?.timings?.transcriptionProcessingDurationMs ?? null,
          reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
          roundTripDurationMs,
          audioSizeBytes: audioBlob.size,
          audioFormat: audioBlob.type,
          outputTextLength: result?.text?.length,
        },
        "performance"
      );
    } catch (error) {
      if (generation !== this._processingGeneration) return;
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.code === "CANCELLED") return;

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
          messageKey: error.messageKey,
          status: error.status,
          serverCode: error.serverCode,
          requestId: error.requestId,
          retryAfterSeconds: error.retryAfterSeconds,
          max_duration_seconds: error.max_duration_seconds,
          fields: error.fields,
        });

        // API failures are transient request state, not workspace history items.
        // Keep retryable audio only in memory until retry, dismissal, or a new recording.
        if (this.lastAudioBlob) {
          this.lastRetryMetadata = metadata;
        }
      }
    } finally {
      if (generation === this._processingGeneration && this.isProcessing) {
        this.isProcessing = false;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      }
    }
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = getBaseLanguageCode(this.getEffectiveSttLanguage(getSettings()));
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        if (this.isDictionaryEcho(result.text)) {
          throw new Error("No audio detected");
        }
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, rawText, source: "local", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(audioBlob, model = "parakeet-tdt-0.6b-v3", metadata = {}) {
    const timings = {};

    try {
      let result;
      const streamedText =
        typeof metadata.streamedText === "string" ? metadata.streamedText.trim() : null;
      // An empty stream is indistinguishable from silence; let the offline decode settle it.
      if (streamedText) {
        logger.debug("Parakeet using committed streaming transcript", { model }, "performance");
        timings.transcriptionProcessingDurationMs = 0;
        result = { success: true, text: streamedText };
      } else {
        const arrayBuffer = await audioBlob.arrayBuffer();

        logger.debug(
          "Parakeet transcription starting",
          {
            audioFormat: audioBlob.type,
            audioSizeBytes: audioBlob.size,
            model,
          },
          "performance"
        );

        const transcriptionStart = performance.now();
        result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, { model });
        timings.transcriptionProcessingDurationMs = Math.round(
          performance.now() - transcriptionStart
        );

        logger.debug(
          "Parakeet transcription complete",
          {
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            success: result.success,
          },
          "performance"
        );
      }

      if (result.success && result.text) {
        const rawText = result.text;
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            rawText,
            source: "local-parakeet",
            timings,
            ...(result.warning ? { warning: result.warning } : {}),
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = getSettings();

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async processWithReasoningModel(text, model, agentName, config) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      hasOverrides: !!config,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const s = getSettings();
    const useReasoning =
      !!s.useCleanupModel || dictationAgentReachable(s) || translationChainReachable(s);
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    if (s.useCleanupModel && isCloudCleanupMode()) {
      this.reasoningAvailabilityCache = {
        value: true,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return true;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  // Cleanup-then-translate chain shared by batch, cloud, and streaming paths: Step 1
  // (optional cleanup) soft-fails to input; Step 2 translates unless source === target.
  async runTranslationChain({ text, settings, agentName, route, cleanup }) {
    const runCleanup = async (currentText) => {
      if (cleanup.mode === "cloudReason") {
        const reasonResult = await withSessionRefresh(async () => {
          const res = await window.electronAPI.cloudReason(currentText, {
            agentName,
            promptMode: "cleanup",
            customDictionary: getDictionaryHintWords(settings),
            customPrompt: this.getCustomPrompt(),
            language: this.getEffectiveSttLanguage(settings) || "auto",
            locale: settings.uiLanguage || "en",
            ...(cleanup.meta || {}),
          });
          if (!res.success) {
            const err = new Error(res.error || "Cloud reasoning failed");
            err.code = res.code;
            throw err;
          }
          return res;
        });
        return reasonResult.success && reasonResult.text ? reasonResult.text : null;
      }
      const cleanupModel = cleanup.model;
      if (cleanupModel) {
        return this.processWithReasoningModel(
          currentText,
          cleanupModel,
          agentName,
          route.cleanupConfig
        );
      }
      return null;
    };

    const runTranslate = async (currentText) =>
      this.processWithReasoningModel(currentText, route.model, agentName, route.config);

    try {
      return await executeTranslationChain({
        text,
        cleanupReachable: route.cleanupReachable,
        cleanupIsCloud: cleanup.mode === "cloudReason",
        runCleanup,
        runTranslate,
        shouldTranslate: shouldRunTranslateStep(
          settings.translationSourceLanguage,
          settings.translationTargetLanguage
        ),
        translateIsCloud: canonicalProviderName(route.config?.provider) === VOICELAB_PROVIDER,
        onCleanupError: (cleanupError) => {
          const { level = "error", channel, extra } = cleanup.log || {};
          logger[level](
            "Cleanup step failed in translation chain, translating raw transcript",
            { ...(extra || {}), error: cleanupError.message },
            channel
          );
        },
        onEmptyTranslate: () => {
          const { channel } = cleanup.log || {};
          logger.warn("Translation step returned empty text, keeping previous text", {}, channel);
          this.notifyTranslationFallback("failed");
        },
      });
    } catch (translateError) {
      // Translate step threw: raw text is still pasted by the caller. Surface the failure.
      this.notifyTranslationFallback("failed");
      throw translateError;
    }
  }

  async processTranscription(text, source) {
    const normalizedText = typeof text === "string" ? text.trim() : "";

    if (!normalizedText) {
      logger.logReasoning("TRANSCRIPTION_EMPTY_SKIPPING_REASONING", {
        source,
        reason: "Empty text after normalization",
      });
      return normalizedText;
    }

    if (this.skipReasoning) {
      logger.logReasoning("REASONING_SKIPPED_AGENT_MODE", {
        source,
        reason: "skipReasoning is set (agent mode) — returning raw transcription",
      });
      return normalizedText;
    }

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const cleanupModel = getEffectiveCleanupModel();
    const isCloud = isCloudCleanupMode();
    const settings = getSettings();
    const cleanupProvider = settings.cleanupProvider || "auto";
    const cleanupReachable = !!settings.useCleanupModel && (!!cleanupModel || isCloud);
    const agentReachable = dictationAgentReachable(settings);
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    if (
      !cleanupReachable &&
      !agentReachable &&
      !(this.translationRequested && translationChainReachable(settings))
    ) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No cleanup or dictation-agent model available",
      });
      return normalizedText;
    }

    const useReasoning = await this.isReasoningAvailable();

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      cleanupModel,
      cleanupProvider,
      agentName,
    });

    if (useReasoning) {
      let route;
      try {
        route = resolveReasoningRoute(
          normalizedText,
          settings,
          agentName,
          this.voiceAgentRequested,
          this.translationRequested
        );
        if (this.translationRequested && route.kind !== "translation") {
          this.notifyTranslationFallback("unreachable");
        }
        if (route.kind === "skip") return normalizedText;

        if (route.kind === "translation") {
          const { text: translatedText } = await this.runTranslationChain({
            text: normalizedText,
            settings,
            agentName,
            route,
            cleanup: {
              mode: "model",
              model: cleanupModel,
              log: { level: "warn", channel: "notes", extra: { source } },
            },
          });

          logger.logReasoning("REASONING_SUCCESS", {
            resultLength: translatedText.length,
            resultPreview:
              translatedText.substring(0, 100) + (translatedText.length > 100 ? "..." : ""),
            processingTime: new Date().toISOString(),
          });

          return translatedText;
        }

        const targetModel = route.kind === "agent" ? route.model : cleanupModel;
        const reasoningConfig = route.config;

        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: targetModel,
          provider: canonicalProviderName(route.config?.provider || cleanupProvider),
          path: route.kind,
          disableThinking: reasoningConfig?.disableThinking,
        });

        const result = await this.processWithReasoningModel(
          normalizedText,
          targetModel,
          agentName,
          reasoningConfig
        );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        logger.warn("Reasoning failed", { source, error: error.message }, "notes");
        if (route?.kind === "cleanup") recordCleanupFailure();
      }
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    return normalizedText;
  }

  async processWithVoiceLabCloud(
    audioBlob,
    metadata = {},
    generation = this._processingGeneration
  ) {
    if (!navigator.onLine) {
      const err = new Error("You're offline. Cloud transcription requires an internet connection.");
      err.code = "OFFLINE";
      err.messageKey = "hooks.audioRecording.errorDescriptions.offline";
      throw err;
    }

    const timings = {};
    const settings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));

    const arrayBuffer = await audioBlob.arrayBuffer();
    if (generation !== this._processingGeneration || this._disposed) {
      throw Object.assign(new Error("Request cancelled"), { code: "CANCELLED" });
    }
    const audioSizeBytes = audioBlob.size;
    const audioFormat = audioBlob.type;
    const opts = { accountId: metadata.accountId ?? this._recordingAccountId };
    if (language) opts.language = language;
    if (audioFormat) opts.mimeType = audioFormat;
    if (Number.isFinite(metadata.durationSeconds)) opts.durationSeconds = metadata.durationSeconds;
    const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";
    if (
      this.translationRequested &&
      !this.skipReasoning &&
      translationChainReachable(settings) &&
      isCloudTranslationMode()
    ) {
      opts.sendLogs = "false";
    }

    const dictionaryPrompt = this.getCustomDictionaryPrompt();
    if (dictionaryPrompt) opts.prompt = dictionaryPrompt;

    const transcriptionStart = performance.now();
    const requestId = globalThis.crypto.randomUUID();
    opts.requestId = requestId;
    this._activeCloudRequestId = requestId;
    let result;
    try {
      const res = await window.electronAPI.cloudTranscribe(arrayBuffer, opts);
      if (!res.success) {
        const err = new Error(res.error || "Cloud transcription failed");
        Object.assign(err, res);
        if (res.messageKey) err.messageKey = res.messageKey;
        else if (res.code === "LIMIT_REACHED") {
          err.messageKey =
            res.messageKey || "hooks.audioRecording.errorDescriptions.walletInsufficient";
        }
        throw err;
      }
      result = res;
    } finally {
      if (this._activeCloudRequestId === requestId) this._activeCloudRequestId = null;
    }
    timings.transcriptionProcessingDurationMs = Math.round(performance.now() - transcriptionStart);
    if (generation !== this._processingGeneration || this._disposed) {
      throw Object.assign(new Error("Request cancelled"), { code: "CANCELLED" });
    }

    const rawText = result.text;
    if (this.isDictionaryEcho(rawText)) {
      throw new Error("No audio detected");
    }
    let processedText = result.text;
    if (processedText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        processedText,
        settings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode = settings.cleanupCloudMode || "openwhispr";

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            processedText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) processedText = reasoned;
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          // Desktop auth is intentionally valid only for the dedicated desktop
          // endpoints. There is no desktop cleanup endpoint yet, so keep the STT
          // result instead of calling the retired website /api/reason boundary.
          logger.debug(
            "Skipping VoiceLab cleanup because no desktop cleanup endpoint is available",
            {},
            "transcription"
          );
        } else if (route.kind === "cleanup") {
          const effectiveModel = getEffectiveCleanupModel();
          if (effectiveModel) {
            const reasoned = await this.processWithReasoningModel(
              processedText,
              effectiveModel,
              agentName,
              route.config
            );
            if (reasoned) processedText = reasoned;
          }
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: processedText,
            settings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: result.sttProvider,
                      sttModel: result.sttModel,
                      sttProcessingMs: result.sttProcessingMs,
                      sttWordCount: result.sttWordCount,
                      sttLanguage: result.sttLanguage,
                      audioDurationMs: result.audioDurationMs,
                      audioSizeBytes,
                      audioFormat,
                    },
                    log: { level: "error", channel: "transcription" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "transcription" },
                  },
          });
          processedText = resolveTranslatedText(processedText, chainResult);
        }
      } catch (reasonError) {
        logger.error(
          "Cloud reasoning failed, using raw transcription",
          { error: reasonError.message },
          "transcription"
        );
        if (route.kind === "cleanup") recordCleanupFailure();
      }
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
    }

    return {
      success: true,
      text: processedText,
      rawText,
      source: VOICELAB_PROVIDER,
      timings,
      limitReached: result.limitReached,
      wordsUsed: result.wordsUsed,
      wordsRemaining: result.wordsRemaining,
      clientTranscriptionId: result.clientTranscriptionId,
      accountId: result.accountId ?? opts.accountId,
      desktopTranscriptionId: result.desktopTranscriptionId ?? null,
      desktopRevision: result.desktopRevision ?? null,
      desktopAudioAvailable: result.desktopAudioAvailable === true,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  getCustomDictionaryArray() {
    return getSettings().customDictionary;
  }

  getCustomPrompt() {
    return getSettings().customPrompts.cleanup || undefined;
  }

  getKeyterms() {
    return this.getCustomDictionaryArray();
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const settings = getSettings();
    const language = getBaseLanguageCode(this.getEffectiveSttLanguage(settings));
    const allowLocalFallback = settings.allowLocalFallback;
    const fallbackModel = settings.fallbackWhisperModel || "base";

    try {
      if (!window.electronAPI?.providerTranscribe) {
        throw new Error("Provider transcription is unavailable in this window");
      }

      const selectedProvider = settings.cloudTranscriptionProvider || "openai";
      const selfHosted = isSelfHostedTranscription(settings);
      const provider = selfHosted ? "lan" : selectedProvider;
      const model = this.getTranscriptionModel();
      const mimeType = audioBlob.type || PCM_WAV_RECORDING_FORMAT.mimeType;
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      const apiCallStart = performance.now();
      const keyterms = this.getKeyterms()
        .map((term) => term.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 100);

      logger.debug(
        "Main-process provider transcription starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: mimeType,
          durationSeconds: metadata.durationSeconds ?? null,
          language,
        },
        "transcription"
      );

      const result = await window.electronAPI.providerTranscribe({
        audioBuffer: await audioBlob.arrayBuffer(),
        mimeType,
        provider,
        model,
        baseUrl: selfHosted
          ? settings.remoteTranscriptionUrl
          : selectedProvider === "custom"
            ? settings.cloudTranscriptionBaseUrl
            : undefined,
        language: language && language !== "auto" ? language : undefined,
        prompt: dictionaryPrompt || undefined,
        keyterms: provider === "xai" ? keyterms : undefined,
        contextBias: provider === "mistral" ? keyterms : undefined,
        environment: provider === "corti" ? settings.cortiEnvironment || "us" : undefined,
        tenant: provider === "corti" ? (settings.cortiTenant || "").trim() || "base" : undefined,
      });

      if (!result?.success) {
        const error = new Error(result?.error || "Provider transcription failed");
        if (result?.code) error.code = result.code;
        throw error;
      }

      const rawText = result.text?.trim();
      if (!rawText) {
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
      if (this.isDictionaryEcho(rawText)) throw new Error("No audio detected");

      timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
      const reasoningStart = performance.now();
      const text = await this.processTranscription(rawText, provider);
      timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);
      const source = (await this.isReasoningAvailable()) ? `${provider}-reasoned` : provider;
      return { success: true, text, rawText, source, timings };
    } catch (error) {
      if (error.message === "No audio detected") throw error;

      const isRemoteMode = !getSettings().useLocalWhisper;
      if (allowLocalFallback && isRemoteMode) {
        try {
          const options = { model: fallbackModel };
          if (language && language !== "auto") options.language = language;
          const result = await window.electronAPI.transcribeLocalWhisper(
            await audioBlob.arrayBuffer(),
            options
          );
          if (result.success && result.text) {
            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) return { success: true, text, source: "local-fallback" };
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `Provider transcription failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }
      throw error;
    }
  }

  getTranscriptionModel() {
    try {
      const s = getSettings();
      const selfHostedModel = resolveSelfHostedTranscriptionModel(s);
      if (selfHostedModel) return selfHostedModel;
      const provider = s.cloudTranscriptionProvider || "openai";
      const trimmedModel = (s.cloudTranscriptionModel || "").trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      if (provider === "tinfoil") {
        return getBatchTranscriptionModel("tinfoil");
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isMistralModel = trimmedModel.startsWith("voxtral-");
        const isCortiModel = trimmedModel.startsWith("corti-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "mistral" && isMistralModel) {
          return trimmedModel;
        }
        if (provider === "corti" && isCortiModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "xai") return "grok-stt";
      if (provider === "mistral") return "voxtral-mini-latest";
      if (provider === "corti") return "corti-transcribe";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  async safePaste(text, options = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      return result?.pasted !== false;
    } catch (error) {
      const message =
        error?.message ??
        (typeof error?.toString === "function" ? error.toString() : String(error));
      this.onError?.({
        title: "Paste Error",
        code: "PASTE_ACCESSIBILITY_REQUIRED",
        description: message,
      });
      return false;
    }
  }

  async saveTranscription(
    text,
    rawText = null,
    {
      clientTranscriptionId,
      desktopTranscriptionId = null,
      desktopRevision = null,
      desktopAudioAvailable = false,
      accountId = this.lastAudioMetadata?.accountId ?? this._recordingAccountId,
    } = {}
  ) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return true;
    }

    const capturedAudioBlob = this.lastAudioBlob;
    const capturedAudioMetadata = this.lastAudioMetadata;
    const provider = canonicalProviderName(capturedAudioMetadata?.provider);
    try {
      const syncSource = provider.startsWith("local")
        ? "local"
        : provider && provider !== VOICELAB_PROVIDER
          ? "byok"
          : null;
      const result = await window.electronAPI.saveTranscription(text, rawText, {
        accountId,
        clientTranscriptionId,
        routeKind: this.translationRequested ? "translation" : null,
        syncSource,
        provider: provider || null,
        model: capturedAudioMetadata?.model || null,
        audioDurationMs: capturedAudioMetadata?.durationMs || null,
        desktopTranscriptionId:
          desktopTranscriptionId ?? capturedAudioMetadata?.desktopTranscriptionId ?? null,
        desktopRevision: desktopRevision ?? capturedAudioMetadata?.desktopRevision ?? null,
        desktopAudioAvailable:
          desktopAudioAvailable || capturedAudioMetadata?.desktopAudioAvailable === true,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      // Save audio if we have a captured blob and the transcription was saved successfully
      if (provider !== VOICELAB_PROVIDER && result?.id && capturedAudioBlob) {
        try {
          const arrayBuffer = await capturedAudioBlob.arrayBuffer();
          await window.electronAPI.saveWavRecording(result.id, arrayBuffer, capturedAudioMetadata);
        } catch (audioErr) {
          // Non-blocking: transcription is saved even if audio save fails
          logger.warn("Failed to save transcription audio", { error: audioErr.message }, "audio");
        }
        if (this.lastAudioBlob === capturedAudioBlob) {
          this.lastAudioBlob = null;
          this.lastAudioMetadata = null;
        }
      }

      return true;
    } catch (error) {
      return false;
    } finally {
      // /v1/desktop/stt never retains source audio. Once its final response has
      // been saved as text locally, release the captured recording as well.
      if (provider === VOICELAB_PROVIDER && this.lastAudioBlob === capturedAudioBlob) {
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
        this.lastRetryMetadata = null;
      }
    }
  }

  async saveFailedTranscription(errorMessage, errorCode = null, metadata = {}) {
    if (!getSettings().dataRetentionEnabled) {
      logger.debug("Skipping failed transcription save — data retention disabled", {}, "audio");
      this.lastAudioBlob = null;
      this.lastAudioMetadata = null;
      return;
    }

    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        accountId: metadata.accountId ?? this._recordingAccountId,
        status: "failed",
        errorMessage,
        errorCode,
        routeKind: this.translationRequested ? "translation" : null,
      });
      if (result?.id) syncService.debouncedPush("transcription", result.id);

      if (result?.id && this.lastAudioBlob) {
        try {
          const durationMs = metadata?.durationSeconds
            ? Math.round(metadata.durationSeconds * 1000)
            : null;
          const arrayBuffer = await this.lastAudioBlob.arrayBuffer();
          await window.electronAPI.saveWavRecording(result.id, arrayBuffer, {
            durationMs,
            provider: null,
            model: null,
          });
        } catch (audioErr) {
          logger.warn(
            "Failed to save audio for failed transcription",
            {
              error: audioErr.message,
            },
            "audio"
          );
        }
        this.lastAudioBlob = null;
        this.lastAudioMetadata = null;
      }
    } catch (error) {
      logger.error(
        "Failed to save failed transcription record",
        {
          error: error.message,
        },
        "audio"
      );
    }
  }

  async saveDiscardedTranscription(blob, durationSeconds, accountId) {
    let savedId = null;
    try {
      const result = await window.electronAPI.saveTranscription("", null, {
        accountId,
        status: "discarded",
        routeKind: this.translationRequested ? "translation" : null,
      });
      if (!result?.id) return;
      savedId = result.id;

      if (blob) {
        const durationMs = durationSeconds ? Math.round(durationSeconds * 1000) : null;
        const arrayBuffer = await blob.arrayBuffer();
        await window.electronAPI.saveWavRecording(savedId, arrayBuffer, {
          durationMs,
          provider: null,
          model: null,
        });
      }

      syncService.debouncedPush("transcription", savedId);
    } catch (error) {
      logger.error(
        "Failed to save discarded transcription record",
        { error: error.message },
        "audio"
      );
      // A discarded row is only recoverable through its audio; if the audio save
      // failed, drop the dead row instead of leaving an empty unrecoverable entry. See #907.
      if (savedId != null) {
        try {
          await window.electronAPI.deleteTranscription(savedId);
        } catch (cleanupError) {
          logger.warn(
            "Failed to clean up discarded row after audio save failure",
            { error: cleanupError.message },
            "audio"
          );
        }
      }
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStreaming: this.isStreaming,
      isStreamingStartInProgress: this.streamingStartInProgress,
      micCaptureStatus: this.micCaptureStatus,
    };
  }

  shouldUseStreaming(_isSignedInOverride) {
    // VoiceLab Desktop currently supports server-metered batch Dictate only.
    return false;
  }

  async warmupStreamingConnection({ isSignedIn: isSignedInOverride } = {}) {
    if (!this.shouldUseStreaming(isSignedInOverride)) {
      logger.debug("Streaming warmup skipped - not in streaming mode", {}, "streaming");
      return false;
    }

    try {
      const provider = this.getStreamingProvider();
      const [, wsResult] = await Promise.all([
        this.cacheMicrophoneDeviceId(),
        withSessionRefresh(async () => {
          const {
            preferredLanguage: warmupLang,
            cloudTranscriptionModel,
            cloudTranscriptionMode,
            cortiEnvironment,
            cortiTenant,
          } = getSettings();
          const res = await provider.warmup({
            sampleRate: 16000,
            language: warmupLang && warmupLang !== "auto" ? warmupLang : undefined,
            keyterms: this.getKeyterms(),
            model: cloudTranscriptionModel,
            mode: cloudTranscriptionMode === "byok" ? "byok" : VOICELAB_PROVIDER,
            environment: cortiEnvironment,
            tenant: cortiTenant,
          });
          // Throw error to trigger retry if AUTH_EXPIRED
          if (!res.success && res.code) {
            const err = new Error(res.error || "Warmup failed");
            err.code = res.code;
            throw err;
          }
          return res;
        }),
      ]);

      if (wsResult.success) {
        // Pre-load AudioWorklet module so first recording is faster
        try {
          const audioContext = await this.getOrCreateAudioContext();
          if (!this.workletModuleLoaded) {
            await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
            this.workletModuleLoaded = true;
            logger.debug("AudioWorklet module pre-loaded during warmup", {}, "streaming");
          }
        } catch (e) {
          logger.debug(
            "AudioWorklet pre-load failed (will retry on recording)",
            { error: e.message },
            "streaming"
          );
        }

        // Warm up the OS audio driver by briefly acquiring the mic, then releasing.
        // This forces macOS to initialize the audio subsystem so subsequent
        // getUserMedia calls resolve in ~100-200ms instead of ~500-1000ms.
        if (!this.micDriverWarmedUp) {
          try {
            const constraints = await this.getAudioConstraints();
            const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
            tempStream.getTracks().forEach((track) => track.stop());
            this.micDriverWarmedUp = true;
            logger.debug("Microphone driver pre-warmed", {}, "streaming");
          } catch (e) {
            logger.debug(
              "Mic driver warmup failed (non-critical)",
              { error: e.message },
              "streaming"
            );
          }
        }

        logger.info(
          "Streaming connection warmed up",
          { alreadyWarm: wsResult.alreadyWarm, micCached: !!this.cachedMicDeviceId },
          "streaming"
        );
        return true;
      } else if (wsResult.code === "NO_API") {
        logger.debug("Streaming warmup skipped - API not configured", {}, "streaming");
        return false;
      } else {
        logger.warn("Streaming warmup failed", { error: wsResult.error }, "streaming");
        return false;
      }
    } catch (error) {
      logger.error("Streaming warmup error", { error: error.message }, "streaming");
      return false;
    }
  }

  async getOrCreateAudioContext() {
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      if (this.persistentAudioContext.state === "suspended") {
        await this.persistentAudioContext.resume();
      }
      return this.persistentAudioContext;
    }
    this.persistentAudioContext = new AudioContext({ sampleRate: 16000 });
    this.workletModuleLoaded = false;
    return this.persistentAudioContext;
  }

  startStreamingLevelMeter(stream) {
    this.stopStreamingLevelMeter();
    if (!this.streamingAudioContext || !stream) return;

    try {
      this.streamingLevelAnalyser = this.streamingAudioContext.createAnalyser();
      this.streamingLevelAnalyser.fftSize = 512;
      this.streamingLevelAnalyser.smoothingTimeConstant = 0.72;
      this.streamingLevelSource = this.streamingAudioContext.createMediaStreamSource(stream);
      this.streamingLevelSource.connect(this.streamingLevelAnalyser);

      const samples = new Uint8Array(this.streamingLevelAnalyser.fftSize);
      this.streamingLevelInterval = setInterval(() => {
        if (!this.isRecording || !this.isStreaming || !this.streamingLevelAnalyser) return;
        this.streamingLevelAnalyser.getByteTimeDomainData(samples);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const value = (samples[i] - 128) / 128;
          sum += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
        this.emitAudioLevel(Math.sqrt(sum / samples.length), peak);
      }, 75);
    } catch (error) {
      logger.debug("Streaming audio-level meter unavailable", { error: error.message }, "audio");
      this.stopStreamingLevelMeter();
    }
  }

  replaceStreamingLevelSource(stream) {
    if (!this.streamingAudioContext || !this.streamingLevelAnalyser || !stream) return;
    try {
      this.streamingLevelSource?.disconnect();
      this.streamingLevelSource = this.streamingAudioContext.createMediaStreamSource(stream);
      this.streamingLevelSource.connect(this.streamingLevelAnalyser);
    } catch (error) {
      logger.debug(
        "Failed to replace streaming audio-level source",
        { error: error.message },
        "audio"
      );
    }
  }

  stopStreamingLevelMeter() {
    if (this.streamingLevelInterval) {
      clearInterval(this.streamingLevelInterval);
      this.streamingLevelInterval = null;
    }
    try {
      this.streamingLevelSource?.disconnect();
    } catch {}
    this.streamingLevelSource = null;
    this.streamingLevelAnalyser = null;
    this.emitAudioLevel();
  }

  async startStreamingFallbackRecorder(stream) {
    try {
      const recorder = new PcmWavRecorder({ sampleRate: PCM_WAV_RECORDING_FORMAT.sampleRate });
      await recorder.start(stream);
      this.streamingFallbackRecorder = recorder;
      return recorder;
    } catch (error) {
      logger.debug("Fallback recorder failed to start", { error: error.message }, "streaming");
      this.streamingFallbackRecorder = null;
      return null;
    }
  }

  async finishStreamingFallbackSegment() {
    const recorder = this.streamingFallbackRecorder;
    if (!recorder) return null;
    const wavBuffer = await recorder.stop();
    const blob = new Blob([wavBuffer], { type: PCM_WAV_RECORDING_FORMAT.mimeType });
    this.streamingFallbackRecorder = null;
    if (!isEmptyRecording(blob.size)) this._streamingFallbackSegments.push(blob);
    return blob;
  }

  async replaceStreamingMic(replacement, previous) {
    if (!this.streamingProcessor || !this.streamingAudioContext) {
      throw new Error("Streaming audio pipeline is unavailable");
    }
    const swap = (async () => {
      const nextSource = this.streamingAudioContext.createMediaStreamSource(replacement);
      nextSource.connect(this.streamingProcessor);
      this.streamingSource?.disconnect();
      this.streamingSource = nextSource;
      this.replaceStreamingLevelSource(replacement);
      await this.finishStreamingFallbackSegment();
      if (!this.isStreaming || !this.isRecording) {
        throw new Error("Streaming stopped during microphone recovery");
      }
      await this.startStreamingFallbackRecorder(replacement);
      previous?.getTracks().forEach((track) => track.stop());
      this.streamingStream = replacement;
    })();
    // Expose the swap so stopStreamingRecording can wait for it instead of
    // racing it (losing the newest fallback segment / orphaning a recorder).
    this._streamingMicSwapPromise = swap.catch(() => {});
    try {
      await swap;
    } finally {
      this._streamingMicSwapPromise = null;
    }
  }

  async startStreamingRecording(forceDefaultMic = false) {
    try {
      if (this.streamingStartInProgress) {
        return false;
      }
      this.streamingStartInProgress = true;

      if (this.isRecording || this.isStreaming || this.isProcessing) {
        this.streamingStartInProgress = false;
        return false;
      }

      this.stopRequestedDuringStreamingStart = false;
      await this.captureRecordingAccountId();

      const t0 = performance.now();
      const constraints = await this.getAudioConstraints(forceDefaultMic);
      const tConstraints = performance.now();

      // 1. Get mic stream (can take 10-15s on cold macOS mic driver)
      const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
      const tMedia = performance.now();

      const stream = await this.acquireHealthyMicStream(rawStream, constraints);

      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Streaming recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            usedCachedId: !!this.cachedMicDeviceId,
            muted: audioTrack.muted,
            readyState: audioTrack.readyState,
          },
          "audio"
        );
      }

      // Start fallback recorder in case streaming produces no results.
      this._streamingFallbackSegments = [];
      await this.startStreamingFallbackRecorder(stream);

      // 2. Set up audio pipeline so frames flow the instant WebSocket is ready.
      //    Frames sent before the connection is open are buffered (bounded) by
      //    sendAudio(), not dropped.
      const audioContext = await this.getOrCreateAudioContext();
      this.streamingAudioContext = audioContext;
      this.streamingSource = audioContext.createMediaStreamSource(stream);
      this.streamingStream = stream;

      if (!this.workletModuleLoaded) {
        await audioContext.audioWorklet.addModule(this.getWorkletBlobUrl());
        this.workletModuleLoaded = true;
      }

      this.streamingProcessor = new AudioWorkletNode(audioContext, "pcm-streaming-processor");
      const provider = this.getStreamingProvider();

      this.streamingProcessor.port.onmessage = (event) => {
        if (!this.isStreaming) return;
        provider.send(event.data);
      };

      this.isStreaming = true;
      this.streamingSource.connect(this.streamingProcessor);

      const tPipeline = performance.now();

      // 3. Register IPC event listeners BEFORE connecting, so no transcript
      //    events are lost during the connect handshake.
      this.streamingFinalText = "";
      this.streamingPartialText = "";
      this.streamingTextResolve = null;
      this.streamingTextDebounce = null;

      const partialCleanup = provider.onPartial((text) => {
        this.streamingPartialText = text;
        this.onPartialTranscript?.(text);
      });

      const finalCleanup = provider.onFinal((text) => {
        // text = accumulated final text from streaming provider.
        // Extract just the new segment (delta from previous accumulated final).
        const prevLen = this.streamingFinalText.length;
        this.streamingFinalText = text;
        this.streamingPartialText = "";
        const newSegment = text.slice(prevLen);
        if (newSegment) {
          this.onStreamingCommit?.(newSegment);
        }
      });

      const errorCleanup = provider.onError((error) => {
        logger.error("Streaming provider error", { error }, "streaming");
        this.onError?.({
          title: "Streaming Error",
          description: error,
        });
        if (this.isStreaming) {
          logger.warn("Connection lost during streaming, auto-stopping", {}, "streaming");
          this.stopStreamingRecording().catch((e) => {
            logger.error(
              "Auto-stop after connection loss failed",
              { error: e.message },
              "streaming"
            );
          });
        }
      });

      const sessionEndCleanup = provider.onSessionEnd((data) => {
        logger.debug("Streaming session ended", data, "streaming");
        if (data.text) {
          this.streamingFinalText = data.text;
        }
      });

      this.streamingCleanupFns = [partialCleanup, finalCleanup, errorCleanup, sessionEndCleanup];
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.onStateChange?.({ isRecording: true, isProcessing: false, isStreaming: true });
      this.startStreamingLevelMeter(stream);
      await this.beginMicRecovery(stream);

      // 4. Connect WebSocket — audio is already flowing from the pipeline above,
      //    so Deepgram receives data immediately (no idle timeout).
      const result = await withSessionRefresh(async () => {
        const streamingSettings = getSettings();
        const {
          cloudTranscriptionModel,
          cloudTranscriptionMode,
          cortiEnvironment,
          cortiTenant,
          useLocalWhisper,
        } = streamingSettings;
        const sttLanguage = this.getEffectiveSttLanguage(streamingSettings);
        const res = await provider.start({
          sampleRate: 16000,
          language: sttLanguage && sttLanguage !== "auto" ? sttLanguage : undefined,
          keyterms: this.getKeyterms(),
          model: cloudTranscriptionModel,
          mode: cloudTranscriptionMode === "byok" ? "byok" : VOICELAB_PROVIDER,
          environment: cortiEnvironment,
          tenant: cortiTenant,
        });

        if (!res.success) {
          if (res.code === "NO_API") {
            return { needsFallback: true };
          }
          if (res.code === "NETWORK_ERROR" && useLocalWhisper) {
            this.onError?.({
              code: "NETWORK_ERROR",
              title: "streaming.errors.cloudUnreachable.title",
              description: "Cloud unreachable — using local engine for this recording.",
              messageKey: "streaming.errors.cloudUnreachable.fallback",
            });
            return { needsFallback: true };
          }
          const err = new Error(res.error || "Failed to start streaming session");
          err.code = res.code;
          err.messageKey = res.messageKey;
          err.networkCode = res.networkCode;
          throw err;
        }
        return res;
      });
      const tWs = performance.now();

      if (result.needsFallback) {
        this.isRecording = false;
        this.recordingStartTime = null;
        this.stopRequestedDuringStreamingStart = false;
        await this.cleanupStreaming();
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        this.streamingStartInProgress = false;
        logger.debug(
          "Streaming API not configured, falling back to regular recording",
          {},
          "streaming"
        );
        return this.startRecording();
      }

      logger.info(
        "Streaming start timing",
        {
          constraintsMs: Math.round(tConstraints - t0),
          getUserMediaMs: Math.round(tMedia - tConstraints),
          pipelineMs: Math.round(tPipeline - tMedia),
          wsConnectMs: Math.round(tWs - tPipeline),
          totalMs: Math.round(tWs - t0),
          usedWarmConnection: result.usedWarmConnection,
          micDriverWarmedUp: !!this.micDriverWarmedUp,
        },
        "streaming"
      );

      this.streamingStartInProgress = false;
      if (this.stopRequestedDuringStreamingStart) {
        this.stopRequestedDuringStreamingStart = false;
        logger.debug("Applying deferred streaming stop requested during startup", {}, "streaming");
        return this.stopStreamingRecording();
      }
      return true;
    } catch (error) {
      const stopRequested = this.stopRequestedDuringStreamingStart;
      this.streamingStartInProgress = false;
      this.stopRequestedDuringStreamingStart = false;

      if (isStaleDeviceError(error) && !forceDefaultMic && !stopRequested) {
        // Pinned mic is gone (Chromium rotates IDs / device unplugged). Retry once on the default mic. See #900.
        logger.warn(
          "Pinned microphone unavailable, retrying streaming on default mic",
          {},
          "streaming"
        );
        this.cachedMicDeviceId = null;
        await this.cleanupStreaming();
        this.isRecording = false;
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
        return this.startStreamingRecording(true);
      }

      logger.error("Failed to start streaming recording", { error: error.message }, "streaming");

      let errorTitle = "Streaming Error";
      let errorDescription = `Failed to start streaming: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.code === "AUTH_EXPIRED" || error.code === "AUTH_REQUIRED") {
        errorTitle = "Sign-in Required";
        errorDescription =
          "Your VoiceLab Cloud session is unavailable. Please sign in again from Settings.";
      } else if (error.code === "NETWORK_ERROR") {
        errorTitle = "streaming.errors.cloudUnreachable.title";
        errorDescription = error.messageKey || "streaming.errors.cloudUnreachable.generic";
      } else if (error.name === "MicUnusableError") {
        errorTitle = "Microphone Muted";
        errorDescription =
          "Your microphones stayed muted and produced no audio. Please check your sound input settings and try again.";
      }

      this.onError?.({
        code: error.code,
        messageKey: error.messageKey,
        title: errorTitle,
        description: errorDescription,
      });

      await this.cleanupStreaming();
      this.isRecording = false;
      this.recordingStartTime = null;
      this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });
      return false;
    }
  }

  async stopStreamingRecording() {
    if (this.streamingStartInProgress) {
      this.stopRequestedDuringStreamingStart = true;
      logger.debug("Streaming stop requested while start is in progress", {}, "streaming");
      return true;
    }

    if (!this.isStreaming) return false;
    this.micRecovery.stop();
    // Let an in-flight mic swap settle so its fallback segment isn't lost and
    // its replacement recorder doesn't outlive this stop.
    if (this._streamingMicSwapPromise) await this._streamingMicSwapPromise;

    const durationSeconds = this.recordingStartTime
      ? (Date.now() - this.recordingStartTime) / 1000
      : null;

    const t0 = performance.now();
    let finalText = this.streamingFinalText || "";

    // 1. Update UI immediately
    this.isRecording = false;
    this.recordingStartTime = null;
    this.onStateChange?.({ isRecording: false, isProcessing: true, isStreaming: false });
    this.stopStreamingLevelMeter();

    // 2. Stop the processor — it flushes its remaining buffer on "stop".
    //    Keep isStreaming TRUE so the port.onmessage handler forwards the flush to WebSocket.
    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }
    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }
    this.streamingAudioContext = null;

    // Stop fallback recorder before stopping media tracks
    let fallbackBlob = null;
    await this.finishStreamingFallbackSegment();
    try {
      fallbackBlob = await this.mergeRecordedSegments(this._streamingFallbackSegments);
    } catch (error) {
      logger.warn(
        "Failed to merge streaming fallback audio",
        { error: error.message },
        "streaming"
      );
      fallbackBlob = this.getLargestRecordedSegment(this._streamingFallbackSegments);
    }
    if (fallbackBlob) {
      this.lastAudioBlob = fallbackBlob;
    }
    this.streamingFallbackRecorder = null;
    this._streamingFallbackSegments = [];

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }
    const tAudioCleanup = performance.now();

    // 3. Wait for flushed buffer to travel: port -> main thread -> IPC -> WebSocket -> server.
    //    Then mark streaming done so no further audio is forwarded.
    await new Promise((resolve) => setTimeout(resolve, 120));
    this.isStreaming = false;

    // 4. Finalize tells the provider to process any buffered audio and send final results.
    //    Wait briefly so the server sends back the finalized transcript before disconnect.
    const provider = this.getStreamingProvider();
    provider.finalize?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tForceEndpoint = performance.now();

    const stopResult = await provider.stop().catch((e) => {
      logger.debug("Streaming disconnect error", { error: e.message }, "streaming");
      return { success: false };
    });
    const tTerminate = performance.now();

    finalText = this.streamingFinalText || "";

    if (!finalText && this.streamingPartialText) {
      finalText = this.streamingPartialText;
      logger.debug("Using partial text as fallback", { textLength: finalText.length }, "streaming");
    }

    if (!finalText && stopResult?.text) {
      finalText = stopResult.text;
      logger.debug(
        "Using disconnect result text as fallback",
        { textLength: finalText.length },
        "streaming"
      );
    }

    this.cleanupStreamingListeners();

    logger.info(
      "Streaming stop timing",
      {
        durationSeconds,
        audioCleanupMs: Math.round(tAudioCleanup - t0),
        flushWaitMs: Math.round(tForceEndpoint - tAudioCleanup),
        terminateRoundTripMs: Math.round(tTerminate - tForceEndpoint),
        totalStopMs: Math.round(tTerminate - t0),
        textLength: finalText.length,
      },
      "streaming"
    );

    const stSettings = getSettings();
    const streamingSttModel = stopResult?.model || "nova-3";
    const streamingSttProcessingMs = Math.round(tTerminate - t0);
    const streamingAudioBytesSent = stopResult?.audioBytesSent || 0;
    const streamingSttLanguage =
      getBaseLanguageCode(this.getEffectiveSttLanguage(stSettings)) || undefined;
    const streamingSttWordCount = finalText ? finalText.split(/\s+/).filter(Boolean).length : 0;

    let usedCloudReasoning = false;
    if (finalText && !this.skipReasoning) {
      const reasoningStart = performance.now();
      const agentName = localStorage.getItem("agentName") || null;
      const route = resolveReasoningRoute(
        finalText,
        stSettings,
        agentName,
        this.voiceAgentRequested,
        this.translationRequested
      );
      if (this.translationRequested && route.kind !== "translation") {
        this.notifyTranslationFallback("unreachable");
      }
      const cleanupCloudMode = stSettings.cleanupCloudMode || "openwhispr";

      try {
        if (route.kind === "agent") {
          const reasoned = await this.processWithReasoningModel(
            finalText,
            route.model,
            agentName,
            route.config
          );
          if (reasoned) finalText = reasoned;
          logger.info(
            "Streaming dictation-agent complete",
            { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
            "streaming"
          );
        } else if (route.kind === "cleanup" && cleanupCloudMode === "openwhispr") {
          logger.debug(
            "Skipping VoiceLab cleanup because no desktop cleanup endpoint is available",
            {},
            "streaming"
          );
        } else if (route.kind === "cleanup") {
          const effectiveModel = getEffectiveCleanupModel();
          if (effectiveModel) {
            const reasoned = await this.processWithReasoningModel(
              finalText,
              effectiveModel,
              agentName,
              route.config
            );
            if (reasoned) finalText = reasoned;
            logger.info(
              "Streaming BYOK reasoning complete",
              { reasoningDurationMs: Math.round(performance.now() - reasoningStart) },
              "streaming"
            );
          }
        } else if (route.kind === "translation") {
          const chainResult = await this.runTranslationChain({
            text: finalText,
            settings: stSettings,
            agentName,
            route,
            cleanup:
              cleanupCloudMode === "openwhispr"
                ? {
                    mode: "cloudReason",
                    meta: {
                      sttProvider: this.getStreamingProviderName(),
                      sttModel: streamingSttModel,
                      sttProcessingMs: streamingSttProcessingMs,
                      sttWordCount: streamingSttWordCount,
                      sttLanguage: streamingSttLanguage,
                      audioDurationMs: durationSeconds
                        ? Math.round(durationSeconds * 1000)
                        : undefined,
                      audioSizeBytes: streamingAudioBytesSent || undefined,
                      audioFormat: "linear16",
                    },
                    log: { level: "error", channel: "streaming" },
                  }
                : {
                    mode: "model",
                    model: getEffectiveCleanupModel(),
                    log: { level: "error", channel: "streaming" },
                  },
          });
          finalText = resolveTranslatedText(finalText, chainResult);
          usedCloudReasoning = chainResult.usedCloudReasoning || usedCloudReasoning;
        }
      } catch (reasonError) {
        logger.error(
          "Streaming reasoning failed, using raw text",
          { error: reasonError.message },
          "streaming"
        );
        if (route.kind === "cleanup") recordCleanupFailure();
      }
    }

    // If streaming produced no text, fall back to batch — routed so BYOK audio
    // and cloud audio never cross over (see resolveStreamingFallbackTarget).
    let usedBatchFallback = false;
    let batchWarning = null;
    if (!finalText && durationSeconds > 2 && fallbackBlob?.size > 0) {
      const target = resolveStreamingFallbackTarget(getSettings());
      if (target === "skip") {
        logger.warn("Skipping batch fallback: VoiceLab Cloud session signed out", {}, "streaming");
      } else {
        logger.info(
          "Streaming produced no text, falling back to batch transcription",
          { durationSeconds, blobSize: fallbackBlob.size, target },
          "streaming"
        );
        try {
          // Cloud records usage server-side via /api/transcribe; BYOK has no metering.
          const batchResult =
            target === "cloud"
              ? await this.processWithVoiceLabCloud(fallbackBlob, { durationSeconds })
              : await this.processWithOpenAIAPI(fallbackBlob, { durationSeconds });
          if (batchResult?.text) {
            finalText = batchResult.text;
            usedBatchFallback = true;
            batchWarning = batchResult.warning || null;
            logger.info("Batch fallback succeeded", { textLength: finalText.length }, "streaming");
          }
        } catch (fallbackErr) {
          logger.error("Batch fallback failed", { error: fallbackErr.message }, "streaming");
        }
      }
    }

    if (finalText) {
      const tBeforePaste = performance.now();
      const clientTotalMs = Math.round(tBeforePaste - t0);
      this.lastAudioMetadata = {
        durationMs: durationSeconds
          ? Math.round(durationSeconds * 1000)
          : Math.round(tBeforePaste - t0),
        provider: `${this.getStreamingProviderName()}-streaming`,
        model: streamingSttModel || null,
      };
      this.onTranscriptionComplete?.({
        success: true,
        text: finalText,
        rawText: finalText,
        source: `${this.getStreamingProviderName()}-streaming`,
        ...(batchWarning ? { warning: batchWarning } : {}),
      });

      if (!usedBatchFallback && stSettings.cloudTranscriptionMode === "openwhispr") {
        (async () => {
          try {
            await withSessionRefresh(async () => {
              const res = await window.electronAPI.cloudStreamingUsage(
                finalText,
                durationSeconds ?? 0,
                {
                  sendLogs: !usedCloudReasoning,
                  sttProvider: this.getStreamingProviderName(),
                  sttModel: streamingSttModel,
                  sttProcessingMs: streamingSttProcessingMs,
                  sttLanguage: streamingSttLanguage,
                  audioSizeBytes: streamingAudioBytesSent || undefined,
                  audioFormat: "linear16",
                  clientTotalMs,
                }
              );
              if (!res.success) {
                const err = new Error(res.error || "Streaming usage recording failed");
                err.code = res.code;
                throw err;
              }
            });
          } catch (err) {
            logger.error("Failed to report streaming usage", { error: err.message }, "streaming");
          }
          window.dispatchEvent(new Event("usage-changed"));
        })();
      } else if (usedBatchFallback && stSettings.cloudTranscriptionMode === "openwhispr") {
        window.dispatchEvent(new Event("usage-changed"));
      }

      logger.info(
        "Streaming total processing",
        {
          totalProcessingMs: Math.round(tBeforePaste - t0),
          hasReasoning: stSettings.useCleanupModel || stSettings.useDictationAgent,
        },
        "streaming"
      );
    } else {
      // Silence: still fire callback to dismiss the preview and show the no-audio toast.
      this.onTranscriptionComplete?.({ success: true, text: "" });
    }

    this.isProcessing = false;
    this.onStateChange?.({ isRecording: false, isProcessing: false, isStreaming: false });

    if (this.shouldUseStreaming()) {
      this.warmupStreamingConnection().catch((e) => {
        logger.debug("Background re-warm failed", { error: e.message }, "streaming");
      });
    }

    return true;
  }

  shouldShowPreviewCleanupState() {
    const settings = getSettings();
    return (
      (!!settings.useCleanupModel ||
        !!settings.useDictationAgent ||
        (this.translationRequested && !!settings.useDictationTranslation)) &&
      !this.skipReasoning
    );
  }

  async cleanupPreview(options = {}) {
    const { dismiss = false, showCleanup = false } = options;

    // Claim the session's nodes synchronously so a recording started during the
    // flush await can never have its fresh nodes torn down by this cleanup.
    const processor = this._previewProcessor;
    const source = this._previewSource;
    const audioContext = this._previewAudioContext;
    this._previewProcessor = null;
    this._previewSource = null;
    this._previewAudioContext = null;

    let flushed = true;
    if (processor) {
      // The worklet posts all PCM before "flushed", and the PCM sends share the
      // renderer->main pipe with the stop invoke (FIFO), so the final chunk precedes finish.
      let resolveFlush;
      const flushSentinel = new Promise((resolve) => {
        resolveFlush = () => resolve(true);
      });
      let watchdogTimer;
      const watchdogFired = new Promise((resolve) => {
        watchdogTimer = setTimeout(() => resolve(false), PREVIEW_FLUSH_WATCHDOG_MS);
      });
      this._previewFlushResolve = resolveFlush;
      processor.port.postMessage("stop");
      flushed = await Promise.race([flushSentinel, watchdogFired]);
      clearTimeout(watchdogTimer);
      if (this._previewFlushResolve === resolveFlush) this._previewFlushResolve = null;
      processor.disconnect();
    }
    source?.disconnect();
    audioContext?.close().catch(() => {});
    if (dismiss) {
      window.electronAPI?.dismissDictationPreview?.();
      return null;
    }
    return (await window.electronAPI?.stopDictationPreview?.({ showCleanup, flushed })) || null;
  }

  cleanupStreamingAudio() {
    this.stopStreamingLevelMeter();
    if (this.streamingFallbackRecorder?.state === "recording") {
      try {
        this.streamingFallbackRecorder.stop();
      } catch {}
    }
    this.streamingFallbackRecorder = null;

    if (this.streamingProcessor) {
      try {
        this.streamingProcessor.port.postMessage("stop");
        this.streamingProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingProcessor = null;
    }

    if (this.streamingSource) {
      try {
        this.streamingSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.streamingSource = null;
    }

    this.streamingAudioContext = null;

    if (this.streamingStream) {
      this.streamingStream.getTracks().forEach((track) => track.stop());
      this.streamingStream = null;
    }

    this.isStreaming = false;
  }

  cleanupStreamingListeners() {
    for (const cleanup of this.streamingCleanupFns) {
      try {
        cleanup?.();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    this.streamingCleanupFns = [];
    this.streamingFinalText = "";
    this.streamingPartialText = "";
    this.streamingTextResolve = null;
    clearTimeout(this.streamingTextDebounce);
    this.streamingTextDebounce = null;
  }

  async cleanupStreaming() {
    this.micRecovery.stop();
    this.cleanupStreamingAudio();
    this.cleanupStreamingListeners();
  }

  cleanup() {
    this._disposed = true;
    this.cancelProcessing();
    this.micRecovery.stop();
    this.teardownSpeechGate();
    void this.cleanupPreview({ dismiss: true }).catch((error) => {
      logger.debug("Failed to close dictation preview", { error: error.message }, "audio");
    });
    this.lastAudioBlob = null;
    this.lastAudioMetadata = null;
    if (this.isStreaming) {
      this.cleanupStreaming();
    }
    if (this.wavRecorder?.state === "recording") {
      this.stopRecording();
    }
    if (this.persistentAudioContext && this.persistentAudioContext.state !== "closed") {
      this.persistentAudioContext.close().catch(() => {});
      this.persistentAudioContext = null;
      this.workletModuleLoaded = false;
    }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    try {
      this.getStreamingProvider().stop?.();
    } catch (e) {
      // Ignore errors during cleanup (page may be unloading)
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.onPartialTranscript = null;
    this.onAudioLevel = null;
    this.onStreamingCommit = null;
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    }
  }
}

export { resolveReasoningRoute };
export default AudioManager;
