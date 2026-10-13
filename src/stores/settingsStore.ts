import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n, { normalizeUiLanguage } from "../i18n";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import { useStreamingProvidersStore } from "./streamingProvidersStore";
import logger from "../utils/logger";
import whisperVadConstants from "../constants/whisperVad.json";
import type { LocalTranscriptionProvider, InferenceMode, SelfHostedType } from "../types/electron";
import type { GoogleCalendarAccount } from "../types/calendar";
import { PROMPT_KIND_LIST, type PromptKind } from "../config/prompts/registry";
import { deriveReasoningMode, buildReasoningScopePatches } from "../helpers/reasoningRouting";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
  type InferenceScopeStoreKeys,
} from "../config/inferenceScopes";
import type {
  TranscriptionSettings,
  CleanupSettings,
  HotkeySettings,
  OnboardingSettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
  ChatAgentSettings,
} from "../hooks/useSettings";
import type { Snippet } from "../utils/snippets";
import type { DesktopDictionaryEntry, DesktopDictionaryState } from "../types/electron";

const isBrowser = typeof window !== "undefined";

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getSystemUiLanguage(): string {
  if (!isBrowser) return "en";
  return normalizeUiLanguage(navigator.languages?.[0] || navigator.language || "en");
}

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main dictation/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "meetingUseLocalWhisper"],
  ["whisperModel", "meetingWhisperModel"],
  ["localTranscriptionProvider", "meetingLocalTranscriptionProvider"],
  ["parakeetModel", "meetingParakeetModel"],
  ["cloudTranscriptionProvider", "meetingCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "meetingCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "meetingCloudTranscriptionMode"],
  ["transcriptionMode", "meetingTranscriptionMode"],
  ["remoteTranscriptionType", "meetingRemoteTranscriptionType"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
const MEETING_REASONING_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningProvider", "meetingReasoningProvider"],
  ["reasoningModel", "meetingReasoningModel"],
  ["reasoningMode", "meetingReasoningMode"],
  ["cloudReasoningMode", "meetingCloudReasoningMode"],
  ["cloudReasoningBaseUrl", "meetingCloudReasoningBaseUrl"],
  ["remoteReasoningType", "meetingRemoteReasoningType"],
  ["remoteReasoningUrl", "meetingRemoteReasoningUrl"],
];

function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
    ["meetingFollowsReasoning", MEETING_REASONING_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

migrateMeetingFollowFlags();

// VoiceLab Desktop is cloud-only. Overwrite legacy local/BYOK choices before
// the store hydrates so an existing installation cannot route audio elsewhere.
function enforceVoiceLabCloudTranscription() {
  if (!isBrowser) return;
  for (const key of ["useLocalWhisper", "meetingUseLocalWhisper", "uploadUseLocalWhisper"]) {
    localStorage.setItem(key, "false");
  }
  for (const key of ["transcriptionMode", "meetingTranscriptionMode", "uploadTranscriptionMode"]) {
    localStorage.setItem(key, "openwhispr");
  }
  for (const key of [
    "cloudTranscriptionMode",
    "meetingCloudTranscriptionMode",
    "uploadCloudTranscriptionMode",
  ]) {
    localStorage.setItem(key, "openwhispr");
  }
}

enforceVoiceLabCloudTranscription();

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "meetingUseLocalWhisper",
  "uploadUseLocalWhisper",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "assemblyAiStreaming",
  "autoGenerateNoteTitle",
  "useCleanupModel",
  "useDictationAgent",
  "useDictationTranslation",
  "translationDisableThinking",
  "preferBuiltInMic",
  "cloudBackupEnabled",
  "telemetryEnabled",
  "audioCuesEnabled",
  "pauseMediaOnDictation",
  "floatingIconAutoHide",
  "startMinimized",
  "meetingProcessDetection",
  "speakerDiarizationEnabled",
  "dictationSileroEnabled",
  "noteRecordingSileroEnabled",
  "meetingSileroEnabled",
  "isSignedIn",
  "autoPasteEnabled",
  "systemAudioCaptureEnabled",
  "dataRetentionEnabled",
  "saveDiscardedTranscriptions",
  "noteFilesEnabled",
  "showTranscriptionPreview",
  "cleanupDisableThinking",
  "dictationAgentDisableThinking",
  "noteFormattingDisableThinking",
  "chatAgentDisableThinking",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "notifyUpdates",
  "gcalPrimaryOnly",
]);

const ARRAY_SETTINGS = new Set([
  "snippets",
  "gcalAccounts",
  "onboardingUseCases",
  "translationTargets",
]);

const NUMERIC_SETTINGS = new Set([
  "audioRetentionDays",
  "whisperVadThreshold",
  "whisperVadMinSpeechDurationMs",
  "whisperVadMinSilenceDurationMs",
  "whisperVadMaxSpeechDurationS",
  "whisperVadSpeechPadMs",
  "whisperVadSamplesOverlap",
]);

const WHISPER_VAD_DEFAULTS = whisperVadConstants.DEFAULTS;
const WHISPER_VAD_LIMITS = whisperVadConstants.LIMITS;

type WhisperVadKey = keyof typeof WHISPER_VAD_DEFAULTS;

const clampVadValue = (key: WhisperVadKey, raw: unknown): number => {
  const fallback = WHISPER_VAD_DEFAULTS[key];
  const n = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = WHISPER_VAD_LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
};

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

function deriveTranscriptionMode(
  useLocalWhisper: boolean,
  cloudTranscriptionMode: string | null,
  cloudTranscriptionProvider: string | null
): InferenceMode {
  if (useLocalWhisper) return "local";
  if (cloudTranscriptionMode === "openwhispr") return "openwhispr";
  if (cloudTranscriptionProvider === "custom") return "self-hosted";
  return "providers";
}

function readInferenceMode(key: string, fallback: InferenceMode): InferenceMode {
  const value = readString(key, fallback);
  return value === "openwhispr" ||
    value === "providers" ||
    value === "local" ||
    value === "self-hosted" ||
    value === "enterprise"
    ? value
    : fallback;
}

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const cloudMode = localStorage.getItem("cloudTranscriptionMode");
  const useLocal = localStorage.getItem("useLocalWhisper") === "true";
  const provider = localStorage.getItem("cloudTranscriptionProvider");

  const transcriptionMode = deriveTranscriptionMode(useLocal, cloudMode, provider);
  localStorage.setItem("transcriptionMode", transcriptionMode);

  if (provider === "custom" && cloudMode === "byok") {
    localStorage.setItem("remoteTranscriptionType", "openai-compatible");
    const legacyBaseUrl = localStorage.getItem("cloudTranscriptionBaseUrl");
    const existingRemoteUrl = localStorage.getItem("remoteTranscriptionUrl");
    if (!existingRemoteUrl && legacyBaseUrl && legacyBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE) {
      localStorage.setItem("remoteTranscriptionUrl", legacyBaseUrl);
    }
  }

  const reasoningMode = localStorage.getItem("cloudReasoningMode");
  const reasoningProvider = localStorage.getItem("reasoningProvider");
  let newReasoningMode: InferenceMode = "openwhispr";
  if (reasoningMode === "byok") {
    if (reasoningProvider === "custom") {
      newReasoningMode = "self-hosted";
    } else if (
      reasoningProvider === "bedrock" ||
      reasoningProvider === "azure" ||
      reasoningProvider === "vertex"
    ) {
      newReasoningMode = "enterprise";
    } else if (
      reasoningProvider === "qwen" ||
      reasoningProvider === "llama" ||
      reasoningProvider === "mistral" ||
      reasoningProvider === "openai-oss" ||
      reasoningProvider === "gemma"
    ) {
      newReasoningMode = "local";
    } else {
      newReasoningMode = "providers";
    }
  }
  localStorage.setItem("reasoningMode", newReasoningMode);

  if (reasoningProvider === "custom" && reasoningMode === "byok") {
    localStorage.setItem("remoteReasoningType", "openai-compatible");
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

// One-time seed of the dedicated audio-upload transcription settings. Runs
// after migrateProviderSettings() so the `transcriptionMode` it derives and
// persists is available to copy. Before this context existed the upload page
// used the base dictation settings, so copy each value the user actually set
// into the matching `upload*` key. Fresh installs have no base keys persisted,
// so nothing is copied and the upload context falls through to its OpenWhispr
// Cloud defaults.
const UPLOAD_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "uploadUseLocalWhisper"],
  ["whisperModel", "uploadWhisperModel"],
  ["localTranscriptionProvider", "uploadLocalTranscriptionProvider"],
  ["parakeetModel", "uploadParakeetModel"],
  ["cloudTranscriptionProvider", "uploadCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "uploadCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "uploadCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "uploadCloudTranscriptionMode"],
  ["transcriptionMode", "uploadTranscriptionMode"],
];

function migrateUploadTranscription() {
  if (!isBrowser) return;
  if (localStorage.getItem("uploadTranscriptionMigrated") === "true") return;
  for (const [src, dst] of UPLOAD_TRANSCRIPTION_PAIRS) {
    const v = localStorage.getItem(src);
    if (v !== null) localStorage.setItem(dst, v);
  }
  localStorage.setItem("uploadTranscriptionMigrated", "true");
}

migrateUploadTranscription();

function migrateAgentMode() {
  if (!isBrowser) return;
  if (localStorage.getItem("_agentModeMigrated") === "1") return;

  const cloudAgentMode = localStorage.getItem("cloudAgentMode");
  const agentProvider = localStorage.getItem("agentProvider");

  let agentInferenceMode: InferenceMode = "openwhispr";
  if (cloudAgentMode === "byok") {
    const localProviders = ["qwen", "llama", "mistral", "openai-oss", "gemma"];
    if (agentProvider === "custom") {
      agentInferenceMode = "self-hosted";
    } else if (
      agentProvider === "bedrock" ||
      agentProvider === "azure" ||
      agentProvider === "vertex"
    ) {
      agentInferenceMode = "enterprise";
    } else if (agentProvider && localProviders.includes(agentProvider)) {
      agentInferenceMode = "local";
    } else {
      agentInferenceMode = "providers";
    }
  }
  localStorage.setItem("agentInferenceMode", agentInferenceMode);

  localStorage.setItem("_agentModeMigrated", "1");
}

migrateAgentMode();

function migrateCustomPrompts() {
  if (!isBrowser) return;
  if (localStorage.getItem("_promptsMigrated") === "1") return;

  const legacyUnified = localStorage.getItem("customUnifiedPrompt");
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified);
      if (typeof parsed === "string" && parsed.length > 0) {
        if (!localStorage.getItem("customPrompt.cleanup")) {
          localStorage.setItem("customPrompt.cleanup", parsed);
        }
        if (!localStorage.getItem("customPrompt.dictationAgent")) {
          localStorage.setItem("customPrompt.dictationAgent", parsed);
        }
      }
    } catch {}
    localStorage.removeItem("customUnifiedPrompt");
  }

  const legacyChat = localStorage.getItem("agentSystemPrompt");
  if (legacyChat && legacyChat.length > 0 && !localStorage.getItem("customPrompt.chatAgent")) {
    localStorage.setItem("customPrompt.chatAgent", legacyChat);
  }
  if (legacyChat !== null) localStorage.removeItem("agentSystemPrompt");

  localStorage.setItem("_promptsMigrated", "1");
}

migrateCustomPrompts();

// One-time migration of legacy LLM-scope localStorage keys. Safe to delete
// after a few releases.
const LLM_SCOPE_KEY_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningModel", "cleanupModel"],
  ["reasoningProvider", "cleanupProvider"],
  ["reasoningMode", "cleanupMode"],
  ["useReasoningModel", "useCleanupModel"],
  ["cloudReasoningMode", "cleanupCloudMode"],
  ["cloudReasoningBaseUrl", "cleanupCloudBaseUrl"],
  ["customReasoningApiKey", "cleanupCustomApiKey"],
  ["remoteReasoningUrl", "cleanupRemoteUrl"],
  ["meetingReasoningMode", "noteFormattingMode"],
  ["meetingReasoningProvider", "noteFormattingProvider"],
  ["meetingReasoningModel", "noteFormattingModel"],
  ["meetingCloudReasoningMode", "noteFormattingCloudMode"],
  ["meetingCloudReasoningBaseUrl", "noteFormattingCloudBaseUrl"],
  ["meetingRemoteReasoningUrl", "noteFormattingRemoteUrl"],
  ["agentInferenceMode", "chatAgentMode"],
  ["agentProvider", "chatAgentProvider"],
  ["agentModel", "chatAgentModel"],
  ["cloudAgentMode", "chatAgentCloudMode"],
  ["remoteAgentUrl", "chatAgentRemoteUrl"],
  ["agentKey", "chatAgentKey"],
];

function migrateLLMScopeKeys() {
  if (!isBrowser) return;
  if (localStorage.getItem("_llmScopeKeysMigrated") === "1") return;

  for (const [oldKey, newKey] of LLM_SCOPE_KEY_PAIRS) {
    const value = localStorage.getItem(oldKey);
    if (value === null) continue;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(oldKey);
  }

  localStorage.setItem("_llmScopeKeysMigrated", "1");
}

migrateLLMScopeKeys();

export interface SettingsState
  extends
    TranscriptionSettings,
    CleanupSettings,
    HotkeySettings,
    OnboardingSettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings,
    ChatAgentSettings {
  isSignedIn: boolean;
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  gcalAccounts: GoogleCalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  notifyUpdates: boolean;
  gcalPrimaryOnly: boolean;
  meetingProcessDetection: boolean;
  speakerDiarizationEnabled: boolean;
  dictationSileroEnabled: boolean;
  noteRecordingSileroEnabled: boolean;
  meetingSileroEnabled: boolean;
  whisperVadThreshold: number;
  whisperVadMinSpeechDurationMs: number;
  whisperVadMinSilenceDurationMs: number;
  whisperVadMaxSpeechDurationS: number;
  whisperVadSpeechPadMs: number;
  whisperVadSamplesOverlap: number;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  showTranscriptionPreview: boolean;
  autoPasteEnabled: boolean;
  systemAudioCaptureEnabled: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;

  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;

  meetingTranscriptionMode: InferenceMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;
  meetingCloudTranscriptionBaseUrl: string;
  meetingCloudTranscriptionMode: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;

  uploadTranscriptionMode: InferenceMode;
  uploadUseLocalWhisper: boolean;
  uploadWhisperModel: string;
  uploadLocalTranscriptionProvider: LocalTranscriptionProvider;
  uploadParakeetModel: string;
  uploadCloudTranscriptionProvider: string;
  uploadCloudTranscriptionModel: string;
  uploadCloudTranscriptionBaseUrl: string;
  uploadCloudTranscriptionMode: string;

  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingCloudMode: string;
  noteFormattingCloudBaseUrl: string;
  noteFormattingRemoteUrl: string;
  noteFormattingCustomApiKey: string;

  translationMode: InferenceMode;
  translationProvider: string;
  translationModel: string;
  translationCloudMode: string;
  translationCloudBaseUrl: string;
  translationRemoteUrl: string;
  translationCustomApiKey: string;
  translationDisableThinking: boolean;
  useDictationTranslation: boolean;
  translationSourceLanguage: string;
  translationTargetLanguage: string;
  translationTargets: string[];

  dictationAgentMode: InferenceMode;
  dictationAgentProvider: string;
  dictationAgentModel: string;
  dictationAgentCloudMode: string;
  dictationAgentCloudBaseUrl: string;
  dictationAgentRemoteUrl: string;
  dictationAgentCustomApiKey: string;

  cleanupDisableThinking: boolean;
  dictationAgentDisableThinking: boolean;
  noteFormattingDisableThinking: boolean;
  chatAgentDisableThinking: boolean;

  customPrompts: Record<PromptKind, string>;
  setCustomPrompt: (kind: PromptKind, value: string) => void;

  setDictationAgentMode: (mode: InferenceMode) => void;
  setDictationAgentProvider: (value: string) => void;
  setDictationAgentModel: (value: string) => void;
  setDictationAgentCloudMode: (value: string) => void;
  setDictationAgentCloudBaseUrl: (value: string) => void;
  setDictationAgentRemoteUrl: (url: string) => void;
  setDictationAgentCustomApiKey: (key: string) => void;

  setTranscriptionMode: (mode: InferenceMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setRemoteTranscriptionModel: (model: string) => void;
  setCleanupMode: (mode: InferenceMode) => void;
  setCleanupRemoteUrl: (url: string) => void;

  setMeetingTranscriptionMode: (mode: InferenceMode) => void;
  setMeetingUseLocalWhisper: (value: boolean) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCloudTranscriptionProvider: (value: string) => void;
  setMeetingCloudTranscriptionModel: (value: string) => void;
  setMeetingCloudTranscriptionBaseUrl: (value: string) => void;
  setMeetingCloudTranscriptionMode: (value: string) => void;
  setMeetingRemoteTranscriptionType: (type: SelfHostedType) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;

  setUploadTranscriptionMode: (mode: InferenceMode) => void;
  setUploadUseLocalWhisper: (value: boolean) => void;
  setUploadWhisperModel: (value: string) => void;
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setUploadParakeetModel: (value: string) => void;
  setUploadCloudTranscriptionProvider: (value: string) => void;
  setUploadCloudTranscriptionModel: (value: string) => void;
  setUploadCloudTranscriptionBaseUrl: (value: string) => void;
  setUploadCloudTranscriptionMode: (value: string) => void;

  setNoteFormattingMode: (mode: InferenceMode) => void;
  setNoteFormattingProvider: (value: string) => void;
  setNoteFormattingModel: (value: string) => void;
  setNoteFormattingCloudMode: (value: string) => void;
  setNoteFormattingCloudBaseUrl: (value: string) => void;
  setNoteFormattingRemoteUrl: (url: string) => void;
  setNoteFormattingCustomApiKey: (key: string) => void;

  setTranslationMode: (mode: InferenceMode) => void;
  setTranslationProvider: (value: string) => void;
  setTranslationModel: (value: string) => void;
  setTranslationCloudMode: (value: string) => void;
  setTranslationCloudBaseUrl: (value: string) => void;
  setTranslationRemoteUrl: (value: string) => void;
  setTranslationCustomApiKey: (value: string) => void;
  setTranslationDisableThinking: (value: boolean) => void;
  setUseDictationTranslation: (value: boolean) => void;
  setTranslationSourceLanguage: (value: string) => void;
  setTranslationTargetLanguage: (value: string) => void;
  setTranslationTargets: (targets: string[]) => void;

  setCleanupDisableThinking: (value: boolean) => void;
  setDictationAgentDisableThinking: (value: boolean) => void;
  setNoteFormattingDisableThinking: (value: boolean) => void;
  setChatAgentDisableThinking: (value: boolean) => void;

  setUseLocalWhisper: (value: boolean) => void;
  setWhisperModel: (value: string) => void;
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setParakeetModel: (value: string) => void;
  setAllowOpenAIFallback: (value: boolean) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setFallbackWhisperModel: (value: string) => void;
  setPreferredLanguage: (value: string) => void;
  setCloudTranscriptionProvider: (value: string) => void;
  setCloudTranscriptionModel: (value: string) => void;
  setCloudTranscriptionBaseUrl: (value: string) => void;
  setCloudTranscriptionMode: (value: string) => void;
  setCleanupCloudMode: (value: string) => void;
  setCleanupCloudBaseUrl: (value: string) => void;
  setCustomDictionary: (words: string[]) => void;
  applyCustomDictionaryFromExternal: (words: string[]) => void;
  dictionaryEntries: DesktopDictionaryEntry[];
  dictionaryState: DesktopDictionaryState | null;
  dictionarySaving: boolean;
  createDictionaryWords: (words: string[], language?: string) => Promise<number>;
  updateDictionaryWord: (id: string, displayForm: string) => Promise<void>;
  deleteDictionaryWord: (id: string) => Promise<void>;
  clearDictionaryWords: () => Promise<void>;
  decideLegacyDictionary: (decision: "attach" | "keep_local") => Promise<void>;
  applyDictionaryState: (state: DesktopDictionaryState) => void;
  setSnippets: (snippets: Snippet[]) => void;
  applySnippetsFromExternal: (snippets: Snippet[]) => void;
  setAssemblyAiStreaming: (value: boolean) => void;
  setAutoGenerateNoteTitle: (value: boolean) => void;
  setUseCleanupModel: (value: boolean) => void;
  setUseDictationAgent: (value: boolean) => void;
  setCleanupModel: (value: string) => void;
  setCleanupProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  setOpenaiApiKey: (key: string) => void;
  setAnthropicApiKey: (key: string) => void;
  setGeminiApiKey: (key: string) => void;
  setGroqApiKey: (key: string) => void;
  setXaiApiKey: (key: string) => void;
  setMistralApiKey: (key: string) => void;
  setOpenrouterApiKey: (key: string) => void;
  setCortiClientId: (key: string) => void;
  setCortiClientSecret: (key: string) => void;
  setCortiApiKey: (key: string) => void;
  setTinfoilApiKey: (key: string) => void;
  setCustomTranscriptionApiKey: (key: string) => void;
  setCleanupCustomApiKey: (key: string) => void;

  // Corti (BYOK)
  cortiEnvironment: string;
  cortiTenant: string;
  setCortiEnvironment: (value: string) => void;
  setCortiTenant: (value: string) => void;

  // Enterprise providers
  bedrockAuthMode: string;
  bedrockRegion: string;
  bedrockProfile: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockSessionToken: string;
  azureEndpoint: string;
  azureApiKey: string;
  azureDeploymentName: string;
  azureApiVersion: string;
  vertexAuthMode: string;
  vertexProject: string;
  vertexLocation: string;
  vertexApiKey: string;
  setBedrockAuthMode: (value: string) => void;
  setBedrockRegion: (value: string) => void;
  setBedrockProfile: (value: string) => void;
  setBedrockAccessKeyId: (key: string) => void;
  setBedrockSecretAccessKey: (key: string) => void;
  setBedrockSessionToken: (key: string) => void;
  setAzureEndpoint: (value: string) => void;
  setAzureApiKey: (key: string) => void;
  setAzureDeploymentName: (value: string) => void;
  setAzureApiVersion: (value: string) => void;
  setVertexAuthMode: (value: string) => void;
  setVertexProject: (value: string) => void;
  setVertexLocation: (value: string) => void;
  setVertexApiKey: (key: string) => void;

  setDictationKey: (key: string) => void;
  setMeetingKey: (key: string) => void;
  setVoiceAgentKey: (key: string) => Promise<boolean>;
  translationKey: string;
  setTranslationKey: (key: string) => Promise<boolean>;
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setOnboardingUseCases: (useCases: string[]) => void;
  setOnboardingUseCaseNote: (note: string) => void;
  setOnboardingRole: (role: string) => void;
  setWritingStylePersonal: (style: string) => void;
  setWritingStyleWork: (style: string) => void;
  setWritingStyleEmail: (style: string) => void;
  setWritingStyleOther: (style: string) => void;
  setActivationMode: (mode: "tap" | "push") => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setSelectedMicDevice: (deviceId: string, label: string) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setCloudBackupEnabled: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setAudioRetentionDays: (days: number) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setSaveDiscardedTranscriptions: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setPauseMediaOnDictation: (value: boolean) => void;
  setFloatingIconAutoHide: (enabled: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setNotifyUpdates: (value: boolean) => void;
  setGcalPrimaryOnly: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setDictationSileroEnabled: (value: boolean) => void;
  setNoteRecordingSileroEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setWhisperVadThreshold: (value: number) => void;
  setWhisperVadMinSpeechDurationMs: (value: number) => void;
  setWhisperVadMinSilenceDurationMs: (value: number) => void;
  setWhisperVadMaxSpeechDurationS: (value: number) => void;
  setWhisperVadSpeechPadMs: (value: number) => void;
  setWhisperVadSamplesOverlap: (value: number) => void;
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => void;
  setShowTranscriptionPreview: (value: boolean) => void;
  setAutoPasteEnabled: (value: boolean) => void;
  setSystemAudioCaptureEnabled: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  setChatAgentModel: (value: string) => void;
  setChatAgentProvider: (value: string) => void;
  setChatAgentKey: (key: string) => Promise<boolean>;
  setChatAgentCloudMode: (value: string) => void;
  setChatAgentMode: (mode: InferenceMode) => void;
  setChatAgentCloudBaseUrl: (value: string) => void;
  setChatAgentRemoteUrl: (url: string) => void;
  setChatAgentCustomApiKey: (key: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => void;
  updateCleanupSettings: (settings: Partial<CleanupSettings>) => void;
  setCloudReasoningForAllScopes: (settings: Partial<CleanupSettings>) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    if (isBrowser) localStorage.setItem(key, value);
    useSettingsStore.setState({ [key]: value });
    if (isBrowser && ["preferredLanguage", "uiLanguage", "theme"].includes(key)) {
      window.dispatchEvent(new Event("voicelab-portable-preference-changed"));
    }
  };
}

/** Writes a string setting whose key is computed rather than known up front. */
export function setStringSetting(key: keyof SettingsState, value: string): void {
  createStringSetter(key)(value);
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
    if (
      isBrowser &&
      ["autoPasteEnabled", "useCleanupModel", "audioCuesEnabled", "pauseMediaOnDictation"].includes(
        key
      )
    ) {
      window.dispatchEvent(new Event("voicelab-portable-preference-changed"));
    }
  };
}

// Setter for hotkeys that must be registered with the main process before
// being persisted. Rolls back to the previous key if registration fails.
// Resolves to false on failure so optimistic UIs (HotkeyListInput) can revert.
function createRegisteredHotkeySetter(
  key: "chatAgentKey" | "voiceAgentKey" | "translationKey",
  label: string,
  getRegisterFn: () =>
    ((hotkey: string) => Promise<{ success: boolean; message: string }>) | undefined,
  fallbackSave?: (hotkey: string) => void
) {
  return async (hotkey: string): Promise<boolean> => {
    if (!isBrowser) {
      useSettingsStore.setState({ [key]: hotkey });
      return true;
    }

    const registerFn = getRegisterFn();
    if (!registerFn) {
      localStorage.setItem(key, hotkey);
      useSettingsStore.setState({ [key]: hotkey });
      fallbackSave?.(hotkey);
      return true;
    }

    const previousKey = useSettingsStore.getState()[key];

    try {
      const result = await registerFn(hotkey);
      if (!result?.success) {
        localStorage.setItem(key, previousKey);
        useSettingsStore.setState({ [key]: previousKey });
        logger.warn(`Failed to update ${label}`, { hotkey, message: result?.message }, "settings");
        return false;
      }

      localStorage.setItem(key, hotkey);
      useSettingsStore.setState({ [key]: hotkey });
      return true;
    } catch (error) {
      logger.warn(
        `Failed to update ${label}`,
        { hotkey, error: error instanceof Error ? error.message : String(error) },
        "settings"
      );
      return false;
    }
  };
}

const SECRET_CREDENTIAL_IDS = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gemini",
  groq: "groq",
  xai: "xai",
  mistral: "mistral",
  openrouter: "openrouter",
  cortiClientId: "cortiClientId",
  cortiClientSecret: "cortiClientSecret",
  cortiApiKey: "cortiApiKey",
  tinfoil: "tinfoil",
  customTranscription: "customTranscription",
  cleanupCustom: "cleanupCustom",
  bedrockAccessKeyId: "bedrockAccessKeyId",
  bedrockSecretAccessKey: "bedrockSecretAccessKey",
  bedrockSessionToken: "bedrockSessionToken",
  azureApiKey: "azureApiKey",
  vertexApiKey: "vertexApiKey",
} as const;

const STORED_SECRET_PLACEHOLDER = "••••••••";
type SecretProvider = keyof typeof SECRET_CREDENTIAL_IDS;

const secretSaveTimers: Partial<Record<SecretProvider, ReturnType<typeof setTimeout>>> = {};
function debouncedSaveSecret(provider: SecretProvider, key: string) {
  if (!isBrowser) return;
  const timer = secretSaveTimers[provider];
  if (timer) clearTimeout(timer);
  secretSaveTimers[provider] = setTimeout(() => {
    window.electronAPI
      .providerSaveCredential?.(SECRET_CREDENTIAL_IDS[provider], key)
      ?.catch((err) => {
        logger.warn(
          "Failed to persist secret",
          { provider, error: (err as Error).message },
          "settings"
        );
      });
  }, 250);
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "xaiApiKey",
  "mistralApiKey",
  "openrouterApiKey",
  "cortiClientId",
  "cortiClientSecret",
  "cortiApiKey",
  "tinfoilApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "noteFormattingCustomApiKey",
  "translationCustomApiKey",
  "chatAgentCustomApiKey",
  "dictationAgentCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

// Uniform BYOK key setter: persist to the secure store (debounced) and clear
// the provider's cached key. cacheProvider is omitted where there is no scoped
// cache to clear (xai), preserving prior behavior.
function createSecretSetter(storeKey: string, saver: SecretProvider, _cacheProvider?: string) {
  return (key: string) => {
    if (key === STORED_SECRET_PLACEHOLDER) return;
    useSettingsStore.setState({ [storeKey]: key });
    debouncedSaveSecret(saver, key);
  };
}

export const MAX_TRANSLATION_TARGETS = 5;

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  uiLanguage: normalizeUiLanguage(
    isBrowser ? localStorage.getItem("uiLanguage") || getSystemUiLanguage() : "en"
  ),
  whisperModel: readString("whisperModel", "base"),
  localTranscriptionProvider: (readString("localTranscriptionProvider", "whisper") === "nvidia"
    ? "nvidia"
    : "whisper") as LocalTranscriptionProvider,
  parakeetModel: readString("parakeetModel", ""),
  allowOpenAIFallback: readBoolean("allowOpenAIFallback", false),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  fallbackWhisperModel: readString("fallbackWhisperModel", "base"),
  preferredLanguage: readString("preferredLanguage", "auto"),
  cloudTranscriptionProvider: readString("cloudTranscriptionProvider", "openai"),
  cloudTranscriptionModel: readString("cloudTranscriptionModel", "gpt-4o-mini-transcribe"),
  cloudTranscriptionBaseUrl: readString(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE
  ),
  cloudTranscriptionMode: readString("cloudTranscriptionMode", "openwhispr"),
  useLocalWhisper: false,
  cleanupCloudMode: readString("cleanupCloudMode", "openwhispr"),
  cleanupCloudBaseUrl: readString("cleanupCloudBaseUrl", API_ENDPOINTS.OPENAI_BASE),
  cortiEnvironment: readString("cortiEnvironment", "us"),
  cortiTenant: readString("cortiTenant", "base"),
  customDictionary: [],
  dictionaryEntries: [],
  dictionaryState: null,
  dictionarySaving: false,
  snippets: (() => {
    try {
      const parsed = JSON.parse(readString("snippets", "[]"));
      return Array.isArray(parsed) ? (parsed as Snippet[]) : [];
    } catch {
      return [];
    }
  })(),
  assemblyAiStreaming: readBoolean("assemblyAiStreaming", true),

  autoGenerateNoteTitle: readBoolean("autoGenerateNoteTitle", true),
  useCleanupModel: readBoolean("useCleanupModel", true),
  useDictationAgent: readBoolean("useDictationAgent", true),
  cleanupModel: readString("cleanupModel", ""),
  cleanupProvider: readString("cleanupProvider", "openai"),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  openaiApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  groqApiKey: "",
  xaiApiKey: "",
  mistralApiKey: "",
  openrouterApiKey: "",
  cortiClientId: "",
  cortiClientSecret: "",
  cortiApiKey: "",
  tinfoilApiKey: "",
  customTranscriptionApiKey: "",
  cleanupCustomApiKey: "",

  // Enterprise providers
  bedrockAuthMode: readString("bedrockAuthMode", "sso"),
  bedrockRegion: readString("bedrockRegion", "us-east-1"),
  bedrockProfile: readString("bedrockProfile", ""),
  bedrockAccessKeyId: "",
  bedrockSecretAccessKey: "",
  bedrockSessionToken: "",
  azureEndpoint: readString("azureEndpoint", ""),
  azureApiKey: "",
  azureDeploymentName: readString("azureDeploymentName", ""),
  azureApiVersion: readString("azureApiVersion", "2024-10-21"),
  vertexAuthMode: readString("vertexAuthMode", "adc"),
  vertexProject: readString("vertexProject", ""),
  vertexLocation: readString("vertexLocation", "us-central1"),
  vertexApiKey: "",

  dictationKey: readString("dictationKey", ""),
  activeDictationKey: null,
  meetingKey: readString("meetingKey", ""),
  voiceAgentKey: readString("voiceAgentKey", ""),
  translationKey: readString("translationKey", ""),
  onboardingUseCases: readStringArray("onboardingUseCases", []),
  onboardingUseCaseNote: readString("onboardingUseCaseNote", ""),
  onboardingRole: readString("onboardingRole", ""),
  writingStylePersonal: readString("writingStylePersonal", ""),
  writingStyleWork: readString("writingStyleWork", ""),
  writingStyleEmail: readString("writingStyleEmail", ""),
  writingStyleOther: readString("writingStyleOther", ""),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",
  activationMode: (readString("activationMode", "tap") === "push" ? "push" : "tap") as
    "tap" | "push",

  preferBuiltInMic: readBoolean("preferBuiltInMic", true),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),
  selectedMicDeviceLabel: readString("selectedMicDeviceLabel", ""),

  theme: (() => {
    const v = readString("theme", "auto");
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto" as const;
  })(),
  cloudBackupEnabled: readBoolean("cloudBackupEnabled", false),
  telemetryEnabled: readBoolean("telemetryEnabled", false),
  audioRetentionDays: (() => {
    if (!isBrowser) return 30;
    const stored = localStorage.getItem("audioRetentionDays");
    if (stored === null) return 30;
    const parsed = parseInt(stored, 10);
    return isNaN(parsed) ? 30 : parsed;
  })(),
  dataRetentionEnabled: readBoolean("dataRetentionEnabled", true),
  saveDiscardedTranscriptions: readBoolean("saveDiscardedTranscriptions", false),
  audioCuesEnabled: readBoolean("audioCuesEnabled", true),
  pauseMediaOnDictation: readBoolean("pauseMediaOnDictation", false),
  floatingIconAutoHide: readBoolean("floatingIconAutoHide", false),
  startMinimized: readBoolean("startMinimized", false),
  notificationsEnabled: readBoolean("notificationsEnabled", true),
  notifyMeetingDetection: readBoolean("notifyMeetingDetection", true),
  notifyCalendarReminders: readBoolean("notifyCalendarReminders", true),
  notifyUpdates: readBoolean("notifyUpdates", true),
  ...(() => {
    let accounts: GoogleCalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("gcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    };
  })(),
  gcalPrimaryOnly: readBoolean("gcalPrimaryOnly", true),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  dictationSileroEnabled: readBoolean("dictationSileroEnabled", true),
  noteRecordingSileroEnabled: readBoolean("noteRecordingSileroEnabled", true),
  meetingSileroEnabled: readBoolean("meetingSileroEnabled", true),
  whisperVadThreshold: clampVadValue("threshold", readString("whisperVadThreshold", "0.5")),
  whisperVadMinSpeechDurationMs: clampVadValue(
    "minSpeechDurationMs",
    readString("whisperVadMinSpeechDurationMs", "250")
  ),
  whisperVadMinSilenceDurationMs: clampVadValue(
    "minSilenceDurationMs",
    readString("whisperVadMinSilenceDurationMs", "200")
  ),
  whisperVadMaxSpeechDurationS: clampVadValue(
    "maxSpeechDurationS",
    readString("whisperVadMaxSpeechDurationS", "30")
  ),
  whisperVadSpeechPadMs: clampVadValue("speechPadMs", readString("whisperVadSpeechPadMs", "100")),
  whisperVadSamplesOverlap: clampVadValue(
    "samplesOverlap",
    readString("whisperVadSamplesOverlap", "0.5")
  ),
  panelStartPosition: (() => {
    const v = readString("panelStartPosition", "bottom-right");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right" as const;
  })(),
  showTranscriptionPreview: readBoolean("showTranscriptionPreview", false),
  autoPasteEnabled: readBoolean("autoPasteEnabled", true),
  systemAudioCaptureEnabled: readBoolean("systemAudioCaptureEnabled", true),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  isSignedIn: readBoolean("isSignedIn", false),

  transcriptionMode: readInferenceMode("transcriptionMode", "openwhispr"),
  remoteTranscriptionType: (() => {
    const v = readString("remoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  remoteTranscriptionModel: readString("remoteTranscriptionModel", ""),
  cleanupMode: (() => {
    const v = readString("cleanupMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  cleanupRemoteUrl: readString("cleanupRemoteUrl", ""),

  meetingTranscriptionMode: "openwhispr",
  meetingUseLocalWhisper: false,
  meetingWhisperModel: readString("meetingWhisperModel", ""),
  meetingLocalTranscriptionProvider: (() => {
    const value = readString("meetingLocalTranscriptionProvider", "whisper");
    return value === "nvidia" || value === "voicelab" ? value : "whisper";
  })() as LocalTranscriptionProvider,
  meetingParakeetModel: readString("meetingParakeetModel", ""),
  meetingCloudTranscriptionProvider: readString("meetingCloudTranscriptionProvider", ""),
  meetingCloudTranscriptionModel: readString("meetingCloudTranscriptionModel", ""),
  meetingCloudTranscriptionBaseUrl: readString("meetingCloudTranscriptionBaseUrl", ""),
  meetingCloudTranscriptionMode: readString("meetingCloudTranscriptionMode", "openwhispr"),
  meetingRemoteTranscriptionType: (() => {
    const v = readString("meetingRemoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),

  uploadTranscriptionMode: "openwhispr",
  uploadUseLocalWhisper: false,
  uploadWhisperModel: readString("uploadWhisperModel", ""),
  uploadLocalTranscriptionProvider: (readString("uploadLocalTranscriptionProvider", "whisper") ===
  "nvidia"
    ? "nvidia"
    : "whisper") as LocalTranscriptionProvider,
  uploadParakeetModel: readString("uploadParakeetModel", ""),
  uploadCloudTranscriptionProvider: readString("uploadCloudTranscriptionProvider", ""),
  uploadCloudTranscriptionModel: readString("uploadCloudTranscriptionModel", ""),
  uploadCloudTranscriptionBaseUrl: readString("uploadCloudTranscriptionBaseUrl", ""),
  uploadCloudTranscriptionMode: readString("uploadCloudTranscriptionMode", "openwhispr"),

  noteFormattingMode: (() => {
    const v = readString("noteFormattingMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  noteFormattingProvider: readString("noteFormattingProvider", ""),
  noteFormattingModel: readString("noteFormattingModel", ""),
  noteFormattingCloudMode: readString("noteFormattingCloudMode", ""),
  noteFormattingCloudBaseUrl: readString("noteFormattingCloudBaseUrl", ""),
  noteFormattingRemoteUrl: readString("noteFormattingRemoteUrl", ""),
  noteFormattingCustomApiKey: "",

  translationMode: (() => {
    const v = readString("translationMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  translationProvider: readString("translationProvider", ""),
  translationModel: readString("translationModel", ""),
  translationCloudMode: readString("translationCloudMode", "openwhispr"),
  translationCloudBaseUrl: readString("translationCloudBaseUrl", ""),
  translationRemoteUrl: readString("translationRemoteUrl", ""),
  translationCustomApiKey: "",
  translationDisableThinking: readBoolean("translationDisableThinking", true),
  useDictationTranslation: readBoolean("useDictationTranslation", false),
  translationSourceLanguage: readString("translationSourceLanguage", "auto"),
  translationTargetLanguage: readString("translationTargetLanguage", ""),
  translationTargets: (() => {
    // Seed from the saved array; otherwise from the single active target if set.
    const stored = isBrowser ? localStorage.getItem("translationTargets") : null;
    if (stored !== null) return readStringArray("translationTargets", []);
    const active = readString("translationTargetLanguage", "");
    return active ? [active] : [];
  })(),

  setTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("transcriptionMode", "openwhispr");
    set({ transcriptionMode: "openwhispr" });
  },
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setRemoteTranscriptionModel: createStringSetter("remoteTranscriptionModel"),
  setCleanupMode: createStringSetter("cleanupMode") as (mode: InferenceMode) => void,
  setCleanupRemoteUrl: createStringSetter("cleanupRemoteUrl"),

  setMeetingTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("meetingTranscriptionMode", "openwhispr");
    set({ meetingTranscriptionMode: "openwhispr" });
  },
  setMeetingUseLocalWhisper: () => {
    if (isBrowser) localStorage.setItem("meetingUseLocalWhisper", "false");
    set({ meetingUseLocalWhisper: false });
  },
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCloudTranscriptionProvider: createStringSetter("meetingCloudTranscriptionProvider"),
  setMeetingCloudTranscriptionModel: createStringSetter("meetingCloudTranscriptionModel"),
  setMeetingCloudTranscriptionBaseUrl: createStringSetter("meetingCloudTranscriptionBaseUrl"),
  setMeetingCloudTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("meetingCloudTranscriptionMode", "openwhispr");
    set({ meetingCloudTranscriptionMode: "openwhispr" });
  },
  setMeetingRemoteTranscriptionType: createStringSetter("meetingRemoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),

  setUploadTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("uploadTranscriptionMode", "openwhispr");
    set({ uploadTranscriptionMode: "openwhispr" });
  },
  setUploadUseLocalWhisper: () => {
    if (isBrowser) localStorage.setItem("uploadUseLocalWhisper", "false");
    set({ uploadUseLocalWhisper: false });
  },
  setUploadWhisperModel: createStringSetter("uploadWhisperModel"),
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("uploadLocalTranscriptionProvider", value);
    useSettingsStore.setState({ uploadLocalTranscriptionProvider: value });
  },
  setUploadParakeetModel: createStringSetter("uploadParakeetModel"),
  setUploadCloudTranscriptionProvider: createStringSetter("uploadCloudTranscriptionProvider"),
  setUploadCloudTranscriptionModel: createStringSetter("uploadCloudTranscriptionModel"),
  setUploadCloudTranscriptionBaseUrl: createStringSetter("uploadCloudTranscriptionBaseUrl"),
  setUploadCloudTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("uploadCloudTranscriptionMode", "openwhispr");
    set({ uploadCloudTranscriptionMode: "openwhispr" });
  },

  setNoteFormattingMode: createStringSetter("noteFormattingMode") as (mode: InferenceMode) => void,
  setNoteFormattingProvider: createStringSetter("noteFormattingProvider"),
  setNoteFormattingModel: createStringSetter("noteFormattingModel"),
  setNoteFormattingCloudMode: createStringSetter("noteFormattingCloudMode"),
  setNoteFormattingCloudBaseUrl: createStringSetter("noteFormattingCloudBaseUrl"),
  setNoteFormattingRemoteUrl: createStringSetter("noteFormattingRemoteUrl"),
  setNoteFormattingCustomApiKey: createSecretSetter("noteFormattingCustomApiKey", "cleanupCustom"),

  setTranslationMode: createStringSetter("translationMode") as (mode: InferenceMode) => void,
  setTranslationProvider: createStringSetter("translationProvider"),
  setTranslationModel: createStringSetter("translationModel"),
  setTranslationCloudMode: createStringSetter("translationCloudMode"),
  setTranslationCloudBaseUrl: createStringSetter("translationCloudBaseUrl"),
  setTranslationRemoteUrl: createStringSetter("translationRemoteUrl"),
  setTranslationCustomApiKey: createSecretSetter("translationCustomApiKey", "cleanupCustom"),
  setTranslationDisableThinking: createBooleanSetter("translationDisableThinking"),
  setUseDictationTranslation: createBooleanSetter("useDictationTranslation"),
  setTranslationSourceLanguage: createStringSetter("translationSourceLanguage"),
  setTranslationTargetLanguage: createStringSetter("translationTargetLanguage"),
  setTranslationTargets: (targets: string[]) => {
    const normalized = Array.from(
      new Set(targets.filter((v) => typeof v === "string" && v.trim() && v !== "auto"))
    );
    if (isBrowser) localStorage.setItem("translationTargets", JSON.stringify(normalized));
    set({ translationTargets: normalized });
    if (isBrowser) {
      window.dispatchEvent(new Event("voicelab-portable-preference-changed"));
    }
  },

  chatAgentModel: readString("chatAgentModel", "openai/gpt-oss-120b"),
  chatAgentProvider: readString("chatAgentProvider", "groq"),
  chatAgentKey: readString("chatAgentKey", ""),
  chatAgentCloudMode: readString("chatAgentCloudMode", "openwhispr"),
  chatAgentMode: (() => {
    const v = readString("chatAgentMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  chatAgentRemoteUrl: readString("chatAgentRemoteUrl", ""),
  chatAgentCloudBaseUrl: readString("chatAgentCloudBaseUrl", ""),
  chatAgentCustomApiKey: "",

  dictationAgentMode: (() => {
    const v = readString("dictationAgentMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  dictationAgentProvider: readString("dictationAgentProvider", ""),
  dictationAgentModel: readString("dictationAgentModel", ""),
  dictationAgentCloudMode: readString("dictationAgentCloudMode", "openwhispr"),
  dictationAgentCloudBaseUrl: readString("dictationAgentCloudBaseUrl", ""),
  dictationAgentRemoteUrl: readString("dictationAgentRemoteUrl", ""),
  dictationAgentCustomApiKey: "",

  cleanupDisableThinking: readBoolean("cleanupDisableThinking", true),
  dictationAgentDisableThinking: readBoolean("dictationAgentDisableThinking", true),
  noteFormattingDisableThinking: readBoolean("noteFormattingDisableThinking", true),
  chatAgentDisableThinking: readBoolean("chatAgentDisableThinking", true),

  customPrompts: PROMPT_KIND_LIST.reduce(
    (acc, kind) => ({ ...acc, [kind]: readString(`customPrompt.${kind}`, "") }),
    {} as Record<PromptKind, string>
  ),
  setCustomPrompt: (kind, value) => {
    if (isBrowser) localStorage.setItem(`customPrompt.${kind}`, value);
    useSettingsStore.setState((s) => ({
      customPrompts: { ...s.customPrompts, [kind]: value },
    }));
  },

  setDictationAgentMode: createStringSetter("dictationAgentMode") as (mode: InferenceMode) => void,
  setDictationAgentProvider: createStringSetter("dictationAgentProvider"),
  setDictationAgentModel: createStringSetter("dictationAgentModel"),
  setDictationAgentCloudMode: createStringSetter("dictationAgentCloudMode"),
  setDictationAgentCloudBaseUrl: createStringSetter("dictationAgentCloudBaseUrl"),
  setDictationAgentRemoteUrl: createStringSetter("dictationAgentRemoteUrl"),
  setDictationAgentCustomApiKey: createSecretSetter("dictationAgentCustomApiKey", "cleanupCustom"),

  setCleanupDisableThinking: createBooleanSetter("cleanupDisableThinking"),
  setDictationAgentDisableThinking: createBooleanSetter("dictationAgentDisableThinking"),
  setNoteFormattingDisableThinking: createBooleanSetter("noteFormattingDisableThinking"),
  setChatAgentDisableThinking: createBooleanSetter("chatAgentDisableThinking"),

  setUseLocalWhisper: () => {
    if (isBrowser) localStorage.setItem("useLocalWhisper", "false");
    set({ useLocalWhisper: false });
  },
  setWhisperModel: createStringSetter("whisperModel"),
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("localTranscriptionProvider", value);
    set({ localTranscriptionProvider: value });
  },
  setParakeetModel: createStringSetter("parakeetModel"),
  setAllowOpenAIFallback: createBooleanSetter("allowOpenAIFallback"),
  setAllowLocalFallback: createBooleanSetter("allowLocalFallback"),
  setFallbackWhisperModel: createStringSetter("fallbackWhisperModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setCloudTranscriptionProvider: createStringSetter("cloudTranscriptionProvider"),
  setCloudTranscriptionModel: createStringSetter("cloudTranscriptionModel"),
  setCloudTranscriptionBaseUrl: createStringSetter("cloudTranscriptionBaseUrl"),
  setCloudTranscriptionMode: () => {
    if (isBrowser) localStorage.setItem("cloudTranscriptionMode", "openwhispr");
    set({ cloudTranscriptionMode: "openwhispr" });
  },
  setCleanupCloudMode: createStringSetter("cleanupCloudMode"),
  setCleanupCloudBaseUrl: createStringSetter("cleanupCloudBaseUrl"),
  setAssemblyAiStreaming: createBooleanSetter("assemblyAiStreaming"),
  setAutoGenerateNoteTitle: createBooleanSetter("autoGenerateNoteTitle"),
  setUseCleanupModel: createBooleanSetter("useCleanupModel"),
  setUseDictationAgent: createBooleanSetter("useDictationAgent"),
  setCleanupProvider: createStringSetter("cleanupProvider"),
  setCleanupModel: createStringSetter("cleanupModel"),

  setCustomDictionary: (words: string[]) => {
    set({ dictionarySaving: true });
    const saveDictionary = window.electronAPI?.setDictionary;
    if (!saveDictionary) {
      set({ dictionarySaving: false });
      return;
    }
    saveDictionary(words)
      .then(async () => {
        const state = await window.electronAPI?.getDictionaryState?.();
        if (state) {
          set({
            customDictionary: state.vocabulary,
            dictionaryEntries: state.entries,
            dictionaryState: state,
          });
        }
        void import("../services/SyncService.js").then(({ syncService }) => {
          if (syncService.canSync()) void syncService.syncDictionaryNow();
        });
      })
      .catch((err) => {
        logger.warn(
          "Failed to sync dictionary to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      })
      .finally(() => set({ dictionarySaving: false }));
  },

  applyDictionaryState: (state: DesktopDictionaryState) => {
    set({
      customDictionary: state.vocabulary,
      dictionaryEntries: state.entries,
      dictionaryState: state,
    });
  },

  // Backward-compatible broadcast handling while old windows are still open.
  applyCustomDictionaryFromExternal: (words: string[]) => {
    set({ customDictionary: words });
  },

  createDictionaryWords: async (words: string[], language = "und") => {
    set({ dictionarySaving: true });
    let created = 0;
    try {
      for (const displayForm of words) {
        const result = await window.electronAPI?.createDictionaryEntry?.({
          displayForm,
          language,
          source: "manual",
        });
        if (result && !result.duplicate) created += 1;
        if (result?.state) get().applyDictionaryState(result.state);
      }
      void import("../services/SyncService.js").then(({ syncService }) => {
        if (syncService.canSync()) void syncService.syncDictionaryNow();
      });
      return created;
    } finally {
      set({ dictionarySaving: false });
    }
  },

  updateDictionaryWord: async (id: string, displayForm: string) => {
    set({ dictionarySaving: true });
    try {
      const result = await window.electronAPI?.updateDictionaryEntry?.(id, { displayForm });
      if (result?.state) get().applyDictionaryState(result.state);
      void import("../services/SyncService.js").then(({ syncService }) => {
        if (syncService.canSync()) void syncService.syncDictionaryNow();
      });
    } finally {
      set({ dictionarySaving: false });
    }
  },

  deleteDictionaryWord: async (id: string) => {
    set({ dictionarySaving: true });
    try {
      const result = await window.electronAPI?.deleteDictionaryEntry?.(id);
      if (result?.state) get().applyDictionaryState(result.state);
      void import("../services/SyncService.js").then(({ syncService }) => {
        if (syncService.canSync()) void syncService.syncDictionaryNow();
      });
    } finally {
      set({ dictionarySaving: false });
    }
  },

  clearDictionaryWords: async () => {
    const entries = get().dictionaryEntries;
    set({ dictionarySaving: true });
    try {
      for (const entry of entries) {
        const result = await window.electronAPI?.deleteDictionaryEntry?.(entry.id);
        if (result?.state) get().applyDictionaryState(result.state);
      }
      void import("../services/SyncService.js").then(({ syncService }) => {
        if (syncService.canSync()) void syncService.syncDictionaryNow();
      });
    } finally {
      set({ dictionarySaving: false });
    }
  },

  decideLegacyDictionary: async (decision: "attach" | "keep_local") => {
    set({ dictionarySaving: true });
    try {
      const state = await window.electronAPI?.decideLegacyDictionary?.(decision);
      if (state) get().applyDictionaryState(state);
      if (decision === "attach") {
        void import("../services/SyncService.js").then(({ syncService }) => {
          if (syncService.canSync()) void syncService.syncDictionaryNow();
        });
      }
    } finally {
      set({ dictionarySaving: false });
    }
  },

  setSnippets: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
    window.electronAPI
      ?.setSnippets?.(snippets)
      .then(() => {
        void import("../services/SyncService.js").then(({ syncService }) => {
          if (syncService.canSync()) void syncService.syncSnippetsNow();
        });
      })
      .catch((err) => {
        logger.warn(
          "Failed to sync snippets to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
  },

  // For broadcasts from main process — DB is already authoritative, only update UI.
  applySnippetsFromExternal: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
  },

  setUiLanguage: (language: string) => {
    const normalized = normalizeUiLanguage(language);
    if (isBrowser) localStorage.setItem("uiLanguage", normalized);
    set({ uiLanguage: normalized });
    if (isBrowser) {
      window.dispatchEvent(new Event("voicelab-portable-preference-changed"));
    }
    void i18n.changeLanguage(normalized);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  setOpenaiApiKey: createSecretSetter("openaiApiKey", "openai", "openai"),
  setAnthropicApiKey: createSecretSetter("anthropicApiKey", "anthropic", "anthropic"),
  setGeminiApiKey: createSecretSetter("geminiApiKey", "gemini", "gemini"),
  setGroqApiKey: createSecretSetter("groqApiKey", "groq", "groq"),
  setXaiApiKey: createSecretSetter("xaiApiKey", "xai"),
  setMistralApiKey: createSecretSetter("mistralApiKey", "mistral", "mistral"),
  setOpenrouterApiKey: createSecretSetter("openrouterApiKey", "openrouter", "openrouter"),
  setCortiClientId: (key: string) => {
    set({ cortiClientId: key });
    debouncedSaveSecret("cortiClientId", key);
  },
  setCortiClientSecret: (key: string) => {
    set({ cortiClientSecret: key });
    debouncedSaveSecret("cortiClientSecret", key);
  },
  setCortiApiKey: createSecretSetter("cortiApiKey", "cortiApiKey", "corti"),
  setCortiEnvironment: createStringSetter("cortiEnvironment"),
  setCortiTenant: createStringSetter("cortiTenant"),
  setTinfoilApiKey: createSecretSetter("tinfoilApiKey", "tinfoil", "tinfoil"),
  setCustomTranscriptionApiKey: (key: string) => {
    set({ customTranscriptionApiKey: key });
    debouncedSaveSecret("customTranscription", key);
  },
  setCleanupCustomApiKey: (key: string) => {
    set({ cleanupCustomApiKey: key });
    debouncedSaveSecret("cleanupCustom", key);
  },

  // Enterprise provider setters
  setBedrockAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockAuthMode", value);
    set({ bedrockAuthMode: value });
  },
  setBedrockRegion: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockRegion", value);
    set({ bedrockRegion: value });
    window.electronAPI?.saveBedrockRegion?.(value);
  },
  setBedrockProfile: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockProfile", value);
    set({ bedrockProfile: value });
    window.electronAPI?.saveBedrockProfile?.(value);
  },
  setBedrockAccessKeyId: (key: string) => {
    set({ bedrockAccessKeyId: key });
    debouncedSaveSecret("bedrockAccessKeyId", key);
  },
  setBedrockSecretAccessKey: (key: string) => {
    set({ bedrockSecretAccessKey: key });
    debouncedSaveSecret("bedrockSecretAccessKey", key);
  },
  setBedrockSessionToken: (key: string) => {
    set({ bedrockSessionToken: key });
    debouncedSaveSecret("bedrockSessionToken", key);
  },
  setAzureEndpoint: (value: string) => {
    if (isBrowser) localStorage.setItem("azureEndpoint", value);
    set({ azureEndpoint: value });
    window.electronAPI?.saveAzureEndpoint?.(value);
  },
  setAzureApiKey: (key: string) => {
    set({ azureApiKey: key });
    debouncedSaveSecret("azureApiKey", key);
  },
  setAzureDeploymentName: (value: string) => {
    if (isBrowser) localStorage.setItem("azureDeploymentName", value);
    set({ azureDeploymentName: value });
    window.electronAPI?.saveAzureDeployment?.(value);
  },
  setAzureApiVersion: (value: string) => {
    if (isBrowser) localStorage.setItem("azureApiVersion", value);
    set({ azureApiVersion: value });
    window.electronAPI?.saveAzureApiVersion?.(value);
  },
  setVertexAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexAuthMode", value);
    set({ vertexAuthMode: value });
  },
  setVertexProject: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexProject", value);
    set({ vertexProject: value });
    window.electronAPI?.saveVertexProject?.(value);
  },
  setVertexLocation: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexLocation", value);
    set({ vertexLocation: value });
    window.electronAPI?.saveVertexLocation?.(value);
  },
  setVertexApiKey: (key: string) => {
    set({ vertexApiKey: key });
    debouncedSaveSecret("vertexApiKey", key);
  },

  setDictationKey: (key: string) => {
    if (isBrowser) localStorage.setItem("dictationKey", key);
    set({ dictationKey: key });
    if (isBrowser) {
      window.electronAPI?.notifyHotkeyChanged?.(key);
      window.electronAPI?.saveDictationKey?.(key);
    }
  },
  setMeetingKey: (key: string) => {
    if (isBrowser) localStorage.setItem("meetingKey", key);
    set({ meetingKey: key });
  },
  setVoiceAgentKey: createRegisteredHotkeySetter(
    "voiceAgentKey",
    "voice agent hotkey",
    () => window.electronAPI?.updateVoiceAgentHotkey
  ),
  setTranslationKey: createRegisteredHotkeySetter(
    "translationKey",
    "translation hotkey",
    () => window.electronAPI?.updateTranslationHotkey
  ),

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setOnboardingUseCases: (useCases: string[]) => {
    if (isBrowser) localStorage.setItem("onboardingUseCases", JSON.stringify(useCases));
    set({ onboardingUseCases: useCases });
  },

  setOnboardingUseCaseNote: createStringSetter("onboardingUseCaseNote"),
  setOnboardingRole: createStringSetter("onboardingRole"),
  setWritingStylePersonal: createStringSetter("writingStylePersonal"),
  setWritingStyleWork: createStringSetter("writingStyleWork"),
  setWritingStyleEmail: createStringSetter("writingStyleEmail"),
  setWritingStyleOther: createStringSetter("writingStyleOther"),

  setActivationMode: (mode: "tap" | "push") => {
    if (isBrowser) localStorage.setItem("activationMode", mode);
    set({ activationMode: mode });
    if (isBrowser) {
      window.electronAPI?.notifyActivationModeChanged?.(mode);
    }
  },

  setPreferBuiltInMic: createBooleanSetter("preferBuiltInMic"),
  setSelectedMicDevice: (deviceId: string, label: string) => {
    if (isBrowser) {
      localStorage.setItem("selectedMicDeviceLabel", label);
      localStorage.setItem("selectedMicDeviceId", deviceId);
    }
    set({ selectedMicDeviceId: deviceId, selectedMicDeviceLabel: label });
  },

  setTheme: (value: "light" | "dark" | "auto") => {
    if (isBrowser) localStorage.setItem("theme", value);
    set({ theme: value });
    if (isBrowser) {
      window.dispatchEvent(new Event("voicelab-portable-preference-changed"));
    }
  },

  setCloudBackupEnabled: createBooleanSetter("cloudBackupEnabled"),
  setTelemetryEnabled: createBooleanSetter("telemetryEnabled"),
  setAudioRetentionDays: (days: number) => {
    if (isBrowser) localStorage.setItem("audioRetentionDays", String(days));
    set({ audioRetentionDays: days });
  },
  setDataRetentionEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", String(value));
    set({ dataRetentionEnabled: value });
    logger.info(
      value
        ? "Data retention enabled — transcriptions and audio will be saved"
        : "Data retention disabled — transcriptions and audio will not be saved",
      {},
      "settings"
    );
  },
  setSaveDiscardedTranscriptions: createBooleanSetter("saveDiscardedTranscriptions"),
  setAudioCuesEnabled: createBooleanSetter("audioCuesEnabled"),
  setPauseMediaOnDictation: createBooleanSetter("pauseMediaOnDictation"),

  setFloatingIconAutoHide: (enabled: boolean) => {
    if (get().floatingIconAutoHide === enabled) return;
    if (isBrowser) localStorage.setItem("floatingIconAutoHide", String(enabled));
    set({ floatingIconAutoHide: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyFloatingIconAutoHideChanged?.(enabled);
    }
  },

  setStartMinimized: (enabled: boolean) => {
    if (get().startMinimized === enabled) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(enabled));
    set({ startMinimized: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(enabled);
    }
  },

  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("gcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    });
  },
  setNotificationsEnabled: createBooleanSetter("notificationsEnabled"),
  setNotifyMeetingDetection: createBooleanSetter("notifyMeetingDetection"),
  setNotifyCalendarReminders: createBooleanSetter("notifyCalendarReminders"),
  setNotifyUpdates: createBooleanSetter("notifyUpdates"),
  setGcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("gcalPrimaryOnly", String(value));
    useSettingsStore.setState({ gcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.gcalSetPrimaryOnly?.(value);
  },
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setDictationSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dictationSileroEnabled", String(value));
    useSettingsStore.setState({ dictationSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ dictationSileroEnabled: value });
    }
  },
  setNoteRecordingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("noteRecordingSileroEnabled", String(value));
    useSettingsStore.setState({ noteRecordingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ noteRecordingSileroEnabled: value });
    }
  },
  setMeetingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("meetingSileroEnabled", String(value));
    useSettingsStore.setState({ meetingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ meetingSileroEnabled: value });
    }
  },
  setWhisperVadThreshold: (value: number) => {
    const next = clampVadValue("threshold", value);
    if (isBrowser) localStorage.setItem("whisperVadThreshold", String(next));
    useSettingsStore.setState({ whisperVadThreshold: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ threshold: next });
    }
  },
  setWhisperVadMinSpeechDurationMs: (value: number) => {
    const next = clampVadValue("minSpeechDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSpeechDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSpeechDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSpeechDurationMs: next });
    }
  },
  setWhisperVadMinSilenceDurationMs: (value: number) => {
    const next = clampVadValue("minSilenceDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSilenceDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSilenceDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSilenceDurationMs: next });
    }
  },
  setWhisperVadMaxSpeechDurationS: (value: number) => {
    const next = clampVadValue("maxSpeechDurationS", value);
    if (isBrowser) localStorage.setItem("whisperVadMaxSpeechDurationS", String(next));
    useSettingsStore.setState({ whisperVadMaxSpeechDurationS: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ maxSpeechDurationS: next });
    }
  },
  setWhisperVadSpeechPadMs: (value: number) => {
    const next = clampVadValue("speechPadMs", value);
    if (isBrowser) localStorage.setItem("whisperVadSpeechPadMs", String(next));
    useSettingsStore.setState({ whisperVadSpeechPadMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ speechPadMs: next });
    }
  },
  setWhisperVadSamplesOverlap: (value: number) => {
    const next = clampVadValue("samplesOverlap", value);
    if (isBrowser) localStorage.setItem("whisperVadSamplesOverlap", String(next));
    useSettingsStore.setState({ whisperVadSamplesOverlap: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ samplesOverlap: next });
    }
  },
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => {
    if (get().panelStartPosition === position) return;
    if (isBrowser) localStorage.setItem("panelStartPosition", position);
    set({ panelStartPosition: position });
    if (isBrowser) {
      window.electronAPI?.notifyPanelStartPositionChanged?.(position);
    }
  },

  setShowTranscriptionPreview: createBooleanSetter("showTranscriptionPreview"),
  setAutoPasteEnabled: createBooleanSetter("autoPasteEnabled"),
  setSystemAudioCaptureEnabled: createBooleanSetter("systemAudioCaptureEnabled"),
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),

  setIsSignedIn: (value: boolean) => {
    if (isBrowser) localStorage.setItem("isSignedIn", String(value));
    set({ isSignedIn: value });
  },

  setChatAgentModel: createStringSetter("chatAgentModel"),
  setChatAgentProvider: createStringSetter("chatAgentProvider"),
  setChatAgentKey: createRegisteredHotkeySetter(
    "chatAgentKey",
    "chat agent hotkey",
    () => window.electronAPI?.updateAgentHotkey,
    (key) => window.electronAPI?.saveAgentKey?.(key)
  ),
  setChatAgentCloudMode: createStringSetter("chatAgentCloudMode"),
  setChatAgentMode: createStringSetter("chatAgentMode") as (mode: InferenceMode) => void,
  setChatAgentCloudBaseUrl: createStringSetter("chatAgentCloudBaseUrl"),
  setChatAgentRemoteUrl: createStringSetter("chatAgentRemoteUrl"),
  setChatAgentCustomApiKey: createSecretSetter("chatAgentCustomApiKey", "cleanupCustom"),

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useLocalWhisper !== undefined) s.setUseLocalWhisper(settings.useLocalWhisper);
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.whisperModel !== undefined) s.setWhisperModel(settings.whisperModel);
    if (settings.localTranscriptionProvider !== undefined)
      s.setLocalTranscriptionProvider(settings.localTranscriptionProvider);
    if (settings.parakeetModel !== undefined) s.setParakeetModel(settings.parakeetModel);
    if (settings.allowOpenAIFallback !== undefined)
      s.setAllowOpenAIFallback(settings.allowOpenAIFallback);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.fallbackWhisperModel !== undefined)
      s.setFallbackWhisperModel(settings.fallbackWhisperModel);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.cloudTranscriptionProvider !== undefined)
      s.setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
    if (settings.cloudTranscriptionModel !== undefined)
      s.setCloudTranscriptionModel(settings.cloudTranscriptionModel);
    if (settings.cloudTranscriptionBaseUrl !== undefined)
      s.setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
    if (settings.cloudTranscriptionMode !== undefined)
      s.setCloudTranscriptionMode(settings.cloudTranscriptionMode);
    if (settings.customDictionary !== undefined) s.setCustomDictionary(settings.customDictionary);
    if (settings.snippets !== undefined) s.setSnippets(settings.snippets);
    if (settings.assemblyAiStreaming !== undefined)
      s.setAssemblyAiStreaming(settings.assemblyAiStreaming);
    if (settings.showTranscriptionPreview !== undefined)
      s.setShowTranscriptionPreview(settings.showTranscriptionPreview);
  },

  // Apply the VoiceLab Cloud transcription config to dictation, note recording,
  // and audio upload together.
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    s.updateTranscriptionSettings(settings);
    const {
      useLocalWhisper,
      cloudTranscriptionMode,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
    } = useSettingsStore.getState();
    // Keep every speech scope aligned with the one supported cloud route.
    const mode = deriveTranscriptionMode(
      useLocalWhisper,
      cloudTranscriptionMode,
      cloudTranscriptionProvider
    );
    s.setTranscriptionMode(mode);
    s.setMeetingTranscriptionMode(mode);
    s.setUploadTranscriptionMode(mode);
    s.setMeetingUseLocalWhisper(useLocalWhisper);
    s.setMeetingCloudTranscriptionMode(cloudTranscriptionMode);
    s.setMeetingCloudTranscriptionProvider(cloudTranscriptionProvider);
    s.setMeetingCloudTranscriptionModel(cloudTranscriptionModel);
    s.setUploadUseLocalWhisper(useLocalWhisper);
    s.setUploadCloudTranscriptionMode(cloudTranscriptionMode);
    s.setUploadCloudTranscriptionProvider(cloudTranscriptionProvider);
    s.setUploadCloudTranscriptionModel(cloudTranscriptionModel);
  },

  updateCleanupSettings: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useCleanupModel !== undefined) s.setUseCleanupModel(settings.useCleanupModel);
    if (settings.useDictationAgent !== undefined)
      s.setUseDictationAgent(settings.useDictationAgent);
    if (settings.cleanupModel !== undefined) s.setCleanupModel(settings.cleanupModel);
    if (settings.cleanupProvider !== undefined) s.setCleanupProvider(settings.cleanupProvider);
    if (settings.cleanupCloudBaseUrl !== undefined)
      s.setCleanupCloudBaseUrl(settings.cleanupCloudBaseUrl);
    if (settings.cleanupCloudMode !== undefined) s.setCleanupCloudMode(settings.cleanupCloudMode);
  },

  // Apply a cleanup config to dictation, then mirror its cloud routing to the
  // other three LLM scopes — used when onboarding routes every reasoning scope to
  // one provider so PHI never reaches a second LLM (e.g. Corti for medical providers).
  setCloudReasoningForAllScopes: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    // Derive the mode from the incoming patch (falling back to current state) so
    // the helper patches are the single source of truth for every scope's mode.
    const mode = deriveReasoningMode(
      settings.cleanupCloudMode ?? s.cleanupCloudMode,
      settings.cleanupProvider ?? s.cleanupProvider
    );
    const {
      dictationCleanup,
      noteFormatting,
      dictationAgent,
      chatIntelligence,
      dictationTranslation,
    } = buildReasoningScopePatches(settings, mode);
    s.updateCleanupSettings(dictationCleanup);
    s.setCleanupMode(dictationCleanup.cleanupMode);
    // Each Settings tab selects on its own mode field, so set the mode for every
    // scope even when the routing fields are absent — otherwise the tab keeps
    // showing the previous provider despite the new cloud routing.
    if (noteFormatting.provider !== undefined) s.setNoteFormattingProvider(noteFormatting.provider);
    if (noteFormatting.model !== undefined) s.setNoteFormattingModel(noteFormatting.model);
    if (noteFormatting.cloudMode !== undefined)
      s.setNoteFormattingCloudMode(noteFormatting.cloudMode);
    s.setNoteFormattingMode(mode);
    if (dictationAgent.provider !== undefined) s.setDictationAgentProvider(dictationAgent.provider);
    if (dictationAgent.model !== undefined) s.setDictationAgentModel(dictationAgent.model);
    if (dictationAgent.cloudMode !== undefined)
      s.setDictationAgentCloudMode(dictationAgent.cloudMode);
    s.setDictationAgentMode(mode);
    if (chatIntelligence.provider !== undefined) s.setChatAgentProvider(chatIntelligence.provider);
    if (chatIntelligence.model !== undefined) s.setChatAgentModel(chatIntelligence.model);
    if (chatIntelligence.cloudMode !== undefined)
      s.setChatAgentCloudMode(chatIntelligence.cloudMode);
    s.setChatAgentMode(mode);
    if (dictationTranslation.provider !== undefined)
      s.setTranslationProvider(dictationTranslation.provider);
    if (dictationTranslation.model !== undefined) s.setTranslationModel(dictationTranslation.model);
    if (dictationTranslation.cloudMode !== undefined)
      s.setTranslationCloudMode(dictationTranslation.cloudMode);
    s.setTranslationMode(mode);
  },

  updateApiKeys: (keys: Partial<ApiKeySettings>) => {
    const s = useSettingsStore.getState();
    if (keys.openaiApiKey !== undefined) s.setOpenaiApiKey(keys.openaiApiKey);
    if (keys.anthropicApiKey !== undefined) s.setAnthropicApiKey(keys.anthropicApiKey);
    if (keys.geminiApiKey !== undefined) s.setGeminiApiKey(keys.geminiApiKey);
    if (keys.groqApiKey !== undefined) s.setGroqApiKey(keys.groqApiKey);
    if (keys.xaiApiKey !== undefined) s.setXaiApiKey(keys.xaiApiKey);
    if (keys.mistralApiKey !== undefined) s.setMistralApiKey(keys.mistralApiKey);
    if (keys.openrouterApiKey !== undefined) s.setOpenrouterApiKey(keys.openrouterApiKey);
    if (keys.cortiClientId !== undefined) s.setCortiClientId(keys.cortiClientId);
    if (keys.cortiClientSecret !== undefined) s.setCortiClientSecret(keys.cortiClientSecret);
    if (keys.cortiApiKey !== undefined) s.setCortiApiKey(keys.cortiApiKey);
    if (keys.tinfoilApiKey !== undefined) s.setTinfoilApiKey(keys.tinfoilApiKey);
    if (keys.customTranscriptionApiKey !== undefined)
      s.setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
    if (keys.cleanupCustomApiKey !== undefined) s.setCleanupCustomApiKey(keys.cleanupCustomApiKey);
  },

  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.chatAgentModel !== undefined) s.setChatAgentModel(settings.chatAgentModel);
    if (settings.chatAgentProvider !== undefined)
      s.setChatAgentProvider(settings.chatAgentProvider);
    if (settings.chatAgentKey !== undefined) s.setChatAgentKey(settings.chatAgentKey);
    if (settings.chatAgentCloudMode !== undefined)
      s.setChatAgentCloudMode(settings.chatAgentCloudMode);
  },
}));

// --- Selectors (derived state, not stored) ---

export const selectIsCloudCleanupMode = (state: SettingsState) =>
  state.isSignedIn && state.cleanupMode === "openwhispr" && state.cleanupCloudMode === "openwhispr";

export const selectEffectiveCleanupProvider = (state: SettingsState) =>
  selectIsCloudCleanupMode(state) ? "openwhispr" : state.cleanupProvider;

export const selectIsCloudChatAgentMode = (state: SettingsState) =>
  state.isSignedIn &&
  state.chatAgentMode === "openwhispr" &&
  state.chatAgentCloudMode === "openwhispr";

export const selectIsCloudDictationAgentMode = (state: SettingsState) =>
  state.isSignedIn &&
  state.dictationAgentMode === "openwhispr" &&
  state.dictationAgentCloudMode === "openwhispr";

export const selectIsCloudTranslationMode = (state: SettingsState) =>
  state.isSignedIn &&
  state.translationMode === "openwhispr" &&
  state.translationCloudMode === "openwhispr";

export const selectIsCloudNoteFormattingMode = (state: SettingsState) => {
  const cfg = selectResolvedNoteFormatting(state);
  return state.isSignedIn && cfg.mode === "openwhispr" && cfg.cloudMode === "openwhispr";
};

export interface ResolvedMeetingTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
}

export const selectResolvedMeetingTranscription = (
  state: SettingsState
): ResolvedMeetingTranscription => {
  const catalog = useStreamingProvidersStore.getState().providers;
  // TODO(1.8.0): Catalog has one cloud entry today (OpenAI Realtime).
  // When a second is added, resolve as `meetingCloudTranscriptionProvider || cloudTranscriptionProvider || catalog[0]?.id`, then validate against catalog.
  const cloudTranscriptionProvider = catalog?.[0]?.id ?? "";

  return {
    useLocalWhisper: state.meetingUseLocalWhisper,
    whisperModel: state.meetingWhisperModel || state.whisperModel,
    localTranscriptionProvider: state.meetingLocalTranscriptionProvider,
    parakeetModel: state.meetingParakeetModel || state.parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel: state.meetingCloudTranscriptionModel || state.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl:
      state.meetingCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
    cloudTranscriptionMode: state.meetingCloudTranscriptionMode || state.cloudTranscriptionMode,
    transcriptionMode: state.meetingTranscriptionMode,
    remoteTranscriptionType: state.meetingRemoteTranscriptionType,
    remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl || state.remoteTranscriptionUrl,
  };
};

export interface ResolvedUploadTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
}

// Audio upload is batch (not streaming), so unset values fall back to the base
// dictation settings — matching the behavior before upload had its own context.
export const selectResolvedUploadTranscription = (
  state: SettingsState
): ResolvedUploadTranscription => ({
  useLocalWhisper: state.uploadUseLocalWhisper,
  whisperModel: state.uploadWhisperModel || state.whisperModel,
  localTranscriptionProvider: state.uploadLocalTranscriptionProvider,
  parakeetModel: state.uploadParakeetModel || state.parakeetModel,
  cloudTranscriptionProvider:
    state.uploadCloudTranscriptionProvider || state.cloudTranscriptionProvider,
  cloudTranscriptionModel: state.uploadCloudTranscriptionModel || state.cloudTranscriptionModel,
  cloudTranscriptionBaseUrl:
    state.uploadCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
  cloudTranscriptionMode: state.uploadCloudTranscriptionMode || state.cloudTranscriptionMode,
  transcriptionMode: state.uploadTranscriptionMode,
});

export interface ResolvedNoteFormatting {
  provider: string;
  model: string;
  mode: InferenceMode;
  cloudMode: string;
  cloudBaseUrl: string;
  remoteUrl: string;
}

export const selectResolvedNoteFormatting = (state: SettingsState): ResolvedNoteFormatting => {
  const cfg = selectResolvedLLMConfig(state, "noteFormatting");
  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: cfg.mode,
    cloudMode: cfg.cloudMode || "",
    cloudBaseUrl: cfg.cloudBaseUrl || "",
    remoteUrl: cfg.remoteUrl || "",
  };
};

export interface ResolvedLLMConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking: boolean;
}

export const selectResolvedLLMConfig = (
  state: SettingsState,
  scope: InferenceScope
): ResolvedLLMConfig => {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const fallback = def.fallbackScope
    ? selectResolvedLLMConfig(state, def.fallbackScope as InferenceScope)
    : undefined;

  const read = (field: keyof InferenceScopeStoreKeys): string | undefined => {
    const key = def.storeKeys[field];
    if (!key) return undefined;
    return (state[key] as string | undefined) || undefined;
  };

  const disableThinkingKey = def.storeKeys.disableThinking;
  const disableThinking = disableThinkingKey ? (state[disableThinkingKey] as boolean) : true;

  return {
    scope,
    mode: state[def.storeKeys.mode] as InferenceMode,
    provider: read("provider") || fallback?.provider || "",
    model: read("model") || fallback?.model || "",
    cloudMode: read("cloudMode") || fallback?.cloudMode,
    cloudBaseUrl: read("cloudBaseUrl") || fallback?.cloudBaseUrl,
    remoteUrl: read("remoteUrl") || fallback?.remoteUrl,
    customApiKey: read("customApiKey"),
    disableThinking,
  };
};

export function setResolvedLLMConfig(
  scope: InferenceScope,
  patch: Partial<Omit<ResolvedLLMConfig, "scope">>
): void {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const updates: Partial<SettingsState> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const storeKey = def.storeKeys[field as keyof InferenceScopeStoreKeys];
    if (!storeKey) continue;
    // Custom provider credentials share one secure-store entry. None of them
    // may be persisted in renderer localStorage.
    const customSecretSetters = {
      cleanupCustomApiKey: "setCleanupCustomApiKey",
      noteFormattingCustomApiKey: "setNoteFormattingCustomApiKey",
      translationCustomApiKey: "setTranslationCustomApiKey",
      chatAgentCustomApiKey: "setChatAgentCustomApiKey",
      dictationAgentCustomApiKey: "setDictationAgentCustomApiKey",
    } as const;
    const customSecretSetter = customSecretSetters[storeKey as keyof typeof customSecretSetters];
    if (customSecretSetter) {
      const setter = useSettingsStore.getState()[customSecretSetter];
      (setter as (secret: string) => void)(value as string);
      continue;
    }
    if (isBrowser) {
      localStorage.setItem(
        storeKey as string,
        typeof value === "boolean" ? String(value) : (value as string)
      );
    }
    (updates as Record<string, unknown>)[storeKey as string] = value;
  }
  if (Object.keys(updates).length > 0) useSettingsStore.setState(updates);
}

export function isCloudChatAgentMode() {
  return selectIsCloudChatAgentMode(useSettingsStore.getState());
}

// --- Convenience getters for non-React code ---

export function getSettings() {
  return useSettingsStore.getState();
}

export function getEffectiveCleanupModel() {
  const state = useSettingsStore.getState();
  if (selectIsCloudCleanupMode(state)) {
    return "";
  }
  return state.cleanupModel;
}

export function isCloudCleanupMode() {
  return selectIsCloudCleanupMode(useSettingsStore.getState());
}

export function isCloudDictationAgentMode() {
  return selectIsCloudDictationAgentMode(useSettingsStore.getState());
}

export function isCloudTranslationMode() {
  return selectIsCloudTranslationMode(useSettingsStore.getState());
}

// --- Initialization ---

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  const state = useSettingsStore.getState();

  if (window.electronAPI) {
    try {
      const legacyCustomSecret = [
        "cleanupCustomApiKey",
        "customReasoningApiKey",
        "noteFormattingCustomApiKey",
        "translationCustomApiKey",
        "chatAgentCustomApiKey",
        "dictationAgentCustomApiKey",
      ]
        .map((key) => localStorage.getItem(key))
        .find((value) => value && value !== STORED_SECRET_PLACEHOLDER);
      const status = await window.electronAPI.providerCredentialStatus?.();
      const configured = status?.credentials || {};
      if (!configured.cleanupCustom && legacyCustomSecret) {
        await window.electronAPI.providerSaveCredential?.("cleanupCustom", legacyCustomSecret);
        configured.cleanupCustom = true;
      }
      const placeholder = (credential: string) =>
        configured[credential] ? STORED_SECRET_PLACEHOLDER : "";

      useSettingsStore.setState({
        openaiApiKey: placeholder("openai"),
        anthropicApiKey: placeholder("anthropic"),
        geminiApiKey: placeholder("gemini"),
        groqApiKey: placeholder("groq"),
        xaiApiKey: placeholder("xai"),
        mistralApiKey: placeholder("mistral"),
        openrouterApiKey: placeholder("openrouter"),
        cortiClientId: placeholder("cortiClientId"),
        cortiClientSecret: placeholder("cortiClientSecret"),
        cortiApiKey: placeholder("cortiApiKey"),
        tinfoilApiKey: placeholder("tinfoil"),
        customTranscriptionApiKey: placeholder("customTranscription"),
        cleanupCustomApiKey: placeholder("cleanupCustom"),
        noteFormattingCustomApiKey: placeholder("cleanupCustom"),
        translationCustomApiKey: placeholder("cleanupCustom"),
        chatAgentCustomApiKey: placeholder("cleanupCustom"),
        dictationAgentCustomApiKey: placeholder("cleanupCustom"),
        bedrockAccessKeyId: placeholder("bedrockAccessKeyId"),
        bedrockSecretAccessKey: placeholder("bedrockSecretAccessKey"),
        bedrockSessionToken: placeholder("bedrockSessionToken"),
        azureApiKey: placeholder("azureApiKey"),
        vertexApiKey: placeholder("vertexApiKey"),
      });

      for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
        localStorage.removeItem(key);
      }
    } catch (err) {
      logger.warn(
        "Failed to hydrate secrets from main process",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync dictation key from main process.
    // localStorage holds the user's preferred hotkey. Only populate from .env
    // when localStorage is empty (fresh install / cleared data).
    try {
      if (!state.dictationKey) {
        const envKey = await window.electronAPI.getDictationKey?.();
        if (envKey) {
          createStringSetter("dictationKey")(envKey);
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Track what is actually registered, separately from the editable
    // dictationKey preference so partial registrations never get persisted.
    // May return constructor default during early startup; corrected by dictation-key-active event later.
    try {
      const activeKey = await window.electronAPI?.getActiveDictationKey?.();
      if (activeKey) {
        useSettingsStore.setState({ activeDictationKey: activeKey });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync active dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync chat agent hotkey from main process
    try {
      const envKey = await window.electronAPI.getAgentKey?.();
      if (envKey && envKey !== state.chatAgentKey) {
        createStringSetter("chatAgentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync chat agent hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync voice agent hotkey from main process
    try {
      const envKey = await window.electronAPI.getVoiceAgentKey?.();
      if (envKey && envKey !== state.voiceAgentKey) {
        createStringSetter("voiceAgentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync voice agent hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync translation hotkey from main process
    try {
      const envKey = await window.electronAPI.getTranslationKey?.();
      if (envKey && envKey !== state.translationKey) {
        createStringSetter("translationKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync translation hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      let envMode = await window.electronAPI.getActivationMode?.();
      if (envMode && envMode !== state.activationMode) {
        if (isBrowser) localStorage.setItem("activationMode", envMode);
        useSettingsStore.setState({ activationMode: envMode });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync activation mode on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync UI language from main process
    try {
      const envLanguage = await window.electronAPI.getUiLanguage?.();
      const resolved = normalizeUiLanguage(envLanguage || state.uiLanguage);
      if (resolved !== state.uiLanguage) {
        if (isBrowser) localStorage.setItem("uiLanguage", resolved);
        useSettingsStore.setState({ uiLanguage: resolved });
      }
      await i18n.changeLanguage(resolved);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(normalizeUiLanguage(state.uiLanguage));
    }

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
    }

    // SQLite is authoritative. Legacy localStorage is intentionally not imported.
    try {
      if (window.electronAPI.getDictionaryState) {
        const dictionaryState = await window.electronAPI.getDictionaryState();
        useSettingsStore.getState().applyDictionaryState(dictionaryState);
      } else if (window.electronAPI.getDictionary) {
        const dbWords = await window.electronAPI.getDictionary();
        useSettingsStore.setState({ customDictionary: dbWords });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictionary on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync snippets from SQLite <-> localStorage
    try {
      if (window.electronAPI.getSnippets) {
        const currentSnippets = useSettingsStore.getState().snippets;
        const dbSnippets = await window.electronAPI.getSnippets();
        if (dbSnippets.length === 0 && currentSnippets.length > 0) {
          await window.electronAPI.setSnippets?.(currentSnippets);
          const normalizedSnippets = await window.electronAPI.getSnippets();
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(normalizedSnippets));
          useSettingsStore.setState({ snippets: normalizedSnippets });
        } else if (dbSnippets.length > 0) {
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(dbSnippets));
          useSettingsStore.setState({ snippets: dbSnippets });
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync snippets on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Audio detection is derived from the meeting-notification toggle in
    // sync-notification-preferences, so only process detection is sent here.
    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.meetingDetectionSetPreferences?.({
        processDetection: currentState.meetingProcessDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync meeting detection preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.syncNotificationPreferences?.({
        notificationsEnabled: currentState.notificationsEnabled,
        notifyMeetingDetection: currentState.notifyMeetingDetection,
        notifyCalendarReminders: currentState.notifyCalendarReminders,
        notifyUpdates: currentState.notifyUpdates,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync notification preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.gcalSetPrimaryOnly?.(currentState.gcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync gcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setWhisperVadConfig?.({
        dictationSileroEnabled: currentState.dictationSileroEnabled,
        noteRecordingSileroEnabled: currentState.noteRecordingSileroEnabled,
        meetingSileroEnabled: currentState.meetingSileroEnabled,
        threshold: currentState.whisperVadThreshold,
        minSpeechDurationMs: currentState.whisperVadMinSpeechDurationMs,
        minSilenceDurationMs: currentState.whisperVadMinSilenceDurationMs,
        maxSpeechDurationS: currentState.whisperVadMaxSpeechDurationS,
        speechPadMs: currentState.whisperVadSpeechPadMs,
        samplesOverlap: currentState.whisperVadSamplesOverlap,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync whisper VAD config on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    ensureAgentNameInDictionary();
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    if (key.startsWith("customPrompt.")) {
      const kind = key.slice("customPrompt.".length) as PromptKind;
      if (!PROMPT_KIND_LIST.includes(kind)) return;
      useSettingsStore.setState((s) => ({
        customPrompts: { ...s.customPrompts, [kind]: newValue },
      }));
      return;
    }

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = Number(newValue);
      if (Number.isNaN(parsed)) {
        value =
          key === "audioRetentionDays" ? 30 : (state as unknown as Record<string, unknown>)[key];
      } else {
        value = key === "audioRetentionDays" ? Math.round(parsed) : parsed;
      }
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "gcalAccounts" && Array.isArray(value)) {
      const accounts = value as GoogleCalendarAccount[];
      useSettingsStore.setState({
        gcalConnected: accounts.length > 0,
        gcalEmail: accounts[0]?.email ?? "",
      });
    }

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });

  // Active hotkey updates from backend — display state, never persisted.
  window.electronAPI?.onDictationKeyActive?.((key: string) => {
    useSettingsStore.setState({ activeDictationKey: key });
  });

  // Sync settings pushed from main process (e.g., hotkey changed in control panel)
  window.electronAPI?.onSettingUpdated?.((data: { key: string; value: unknown }) => {
    const state = useSettingsStore.getState();
    if (
      data.key in state &&
      typeof (state as unknown as Record<string, unknown>)[data.key] !== "function"
    ) {
      localStorage.setItem(
        data.key,
        typeof data.value === "string" ? data.value : JSON.stringify(data.value)
      );
      useSettingsStore.setState({ [data.key]: data.value });
    }
  });
}
