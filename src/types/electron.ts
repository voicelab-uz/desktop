import type { ModelDefinition } from "../models/ModelRegistry";
import type { TinfoilCatalogModel } from "../models/tinfoilModels";

export type LocalTranscriptionProvider = "whisper" | "nvidia" | "voicelab";

export type VoiceLabInferenceMode = "voicelab";
export type LegacyInferenceMode = "openwhispr";
export type InferenceMode =
  | VoiceLabInferenceMode
  | LegacyInferenceMode
  | "providers"
  | "local"
  | "self-hosted"
  | "enterprise";

export type SelfHostedType = "openai-compatible" | "lan";

export type TranscriptionStatus = "completed" | "failed" | "pending" | "discarded";

export type DesktopAuthUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
};

export type DesktopAuthStatus = {
  status: string;
  user: DesktopAuthUser | null;
  errorCode: string | null;
  errorMessage?: string | null;
  errorRequestId?: string | null;
  errorFields?: Record<string, string> | null;
  retryAfterSeconds?: number | null;
};

export type DesktopProfile = {
  user: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  requestId: string;
};

export type TranscriptionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "INSUFFICIENT_CREDITS"
  | "ENTITLEMENT_REQUIRED"
  | "DEVICE_LIMIT"
  | "CONCURRENCY_LIMIT"
  | "DAILY_CAP_REACHED"
  | "RATE_LIMITED"
  | "AUDIO_LIMIT_EXCEEDED"
  | "AUDIO_INVALID"
  | "AUDIO_LANGUAGE_UNSUPPORTED"
  | "NO_SPEECH_DETECTED"
  | "INVALID_REQUEST"
  | "CANCELLED"
  | "IDEMPOTENCY_CONFLICT"
  | "DESKTOP_TRANSCRIPT_CONFLICT"
  | "DESKTOP_TRANSCRIPTION_NOT_FOUND"
  | "DESKTOP_TRANSCRIPTIONS_UNAVAILABLE"
  | "VALIDATION_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "PASTE_ACCESSIBILITY_REQUIRED"
  | "VOICELAB_STREAMING_DISABLED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE"
  | null;

export interface TranscriptionItem {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: TranscriptionStatus;
  error_message: string | null;
  error_code: TranscriptionErrorCode;
  route_kind?: string | null;
  client_transcription_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  desktop_transcription_id?: string | null;
  desktop_revision?: number | null;
  desktop_audio_available?: number;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  cloud_id: string | null;
  created_at: string;
  updated_at: string;
  client_note_id: string;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  workspace_id?: string | null;
  team_id?: string | null;
}

export type ShareVisibility = "private" | "link" | "domain" | "invited";

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

export interface NoteShareInvitation {
  id: string;
  email: string;
  invited_by_user_id: string;
  accepted_at: string | null;
  revoked_at: string | null;
  last_emailed_at: string | null;
  created_at: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  client_folder_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
  workspace_id?: string | null;
  team_id?: string | null;
}

export interface DictionaryEntryItem {
  id: number;
  word: string;
  source: "manual" | "learned";
  created_at: string;
  updated_at: string;
  client_dict_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export interface DesktopDictionaryEntry {
  id: string;
  displayForm: string;
  normalizedKey: string;
  language: string;
  replacement: string | null;
  pronunciation: string | null;
  context: string | null;
  source: "manual" | "learned";
  version: number;
  deletedAt: string | null;
  syncStatus: "saved_local" | "syncing" | "synced" | "conflict" | "error";
  lastErrorCode: string | null;
  updatedAt: string;
}

export interface DesktopDictionaryState {
  accountId: string | null;
  entries: DesktopDictionaryEntry[];
  vocabulary: string[];
  legacyCount: number;
  legacyAttachDecision: "attached" | "keep_local" | null;
  requiresLegacyDecision: boolean;
  supportedLanguages: string[];
  autoDetectionSupported: boolean;
  portablePreferences: Record<string, unknown>;
}

export interface SnippetEntryItem {
  id: number;
  trigger: string;
  replacement: string;
  created_at: string;
  updated_at: string;
  client_snippet_id: string;
  cloud_id: string | null;
  sync_status: "synced" | "pending" | "error";
  deleted_at: string | null;
}

export type WorkspaceRole = "owner" | "admin" | "member";
export type TeamRole = "admin" | "member";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_by_user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  seats: number;
  created_at: string;
  updated_at: string;
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  user_id: string;
  role: WorkspaceRole;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface Team {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface TeamMember {
  user_id: string;
  role: TeamRole;
  joined_at: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  workspace_role: TeamRole;
  team_ids: string[];
  invited_by_user_id: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface InvitationPreview {
  id: string;
  email: string;
  workspace_role: TeamRole;
  team_ids: string[];
  expires_at: string;
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  inviter_name: string | null;
  inviter_email: string | null;
}

export interface WorkspaceApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  description: string | null;
}

export interface NewWorkspaceApiKey extends WorkspaceApiKey {
  key: string;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  vramMb: number;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
}

export type SystemAudioMode = "native" | "loopback" | "portal" | "unsupported";
export type SystemAudioStrategy =
  "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported";

export interface SystemAudioAccessResult {
  granted: boolean;
  status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "unsupported";
  mode: SystemAudioMode;
  supportsPersistentGrant?: boolean;
  supportsPersistentPortalGrant?: boolean;
  supportsNativeCapture?: boolean;
  supportsOnboardingGrant?: boolean;
  requiresRuntimeSharePrompt?: boolean;
  strategy?: SystemAudioStrategy;
  restoreTokenAvailable?: boolean;
  portalVersion?: number | null;
  error?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
  isDownloading?: boolean;
  isInstalling?: boolean;
  downloadProgress?: number;
  info?: UpdateInfoResult | null;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

export interface VulkanGpuResult {
  available: boolean;
  deviceName?: string;
  reason?: string;
  error?: string;
}

export interface LlamaVulkanStatus {
  supported: boolean;
  downloaded: boolean;
  downloading?: boolean;
  error?: string;
}

export interface LlamaVulkanDownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}

export interface LocalLLMModelStatus extends ModelDefinition {
  providerId?: string;
  providerName?: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  downloadedSize: number;
  totalSize: number;
  path: string | null;
}

export type LocalLLMDownloadProgressEvent =
  | {
      type?: "progress";
      modelId: string;
      progress: number;
      downloadedSize: number;
      totalSize: number;
    }
  | {
      type: "complete";
      modelId: string;
      progress: 100;
      downloadedSize?: number;
      totalSize?: number;
    }
  | {
      type: "error";
      modelId: string;
      error: string;
      code?: string;
      details?: unknown;
    };

export interface ConversationPreview {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  cloud_id?: string | null;
  client_conversation_id?: string;
  sync_status?: "synced" | "pending" | "error";
  deleted_at?: string | null;
  message_count: number;
  last_message?: string | null;
  last_message_role?: "user" | "assistant" | "system" | null;
}

export interface ReferralItem {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "completed" | "rewarded";
  created_at: string;
  first_payment_at: string | null;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          restoreClipboard?: boolean;
          allowClipboardFallback?: boolean;
        }
      ) => Promise<void>;
      hideWindow: () => Promise<void>;
      quitApp: () => Promise<{ success: boolean }>;
      showDictationPanel: () => Promise<void>;
      onToggleDictation: (callback: () => void) => () => void;
      onToggleVoiceAgent?: (callback: () => void) => () => void;
      onToggleTranslation?: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;

      // STT config
      getSttConfig?: () => Promise<{
        success: boolean;
        dictation: { mode: string };
        notes: { mode: string };
        streamingProvider: string;
      } | null>;

      getNoteRecordingConfig?: () => Promise<{
        success: boolean;
        providers: Array<{
          id: string;
          name: string;
          models: Array<{ id: string; name: string; default?: boolean }>;
        }>;
      } | null>;

      // Database operations
      saveTranscription: (
        text: string,
        rawText?: string | null,
        options?: {
          status?: TranscriptionStatus;
          errorMessage?: string | null;
          errorCode?: TranscriptionErrorCode;
          clientTranscriptionId?: string;
          accountId?: string | null;
          desktopTranscriptionId?: string | null;
          desktopRevision?: number | null;
          desktopAudioAvailable?: boolean;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (
        limit?: number,
        options?: { includeDiscarded?: boolean }
      ) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      getTranscriptionById: (id: number) => Promise<TranscriptionItem | null>;

      // Audio retention operations
      saveTranscriptionAudio: (
        id: number,
        audioBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      saveWavRecording: (
        id: number,
        wavBuffer: ArrayBuffer,
        metadata?: { durationMs?: number; provider?: string; model?: string }
      ) => Promise<{ success: boolean; path?: string }>;
      getAudioPath: (id: number) => Promise<string | null>;
      showAudioInFolder: (id: number) => Promise<{ success: boolean }>;
      getAudioBuffer: (id: number) => Promise<ArrayBuffer | null>;
      deleteTranscriptionAudio: (id: number) => Promise<{ success: boolean }>;
      getAudioStorageUsage: () => Promise<{ fileCount: number; totalBytes: number }>;
      deleteAllAudio: () => Promise<{ deleted: number }>;
      retryTranscription: (
        id: number,
        settings?: {
          preferredLanguage?: string;
        }
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        error?: string;
        code?: TranscriptionErrorCode;
      }>;
      updateTranscriptionText: (
        id: number,
        text: string,
        rawText: string
      ) => Promise<{ success: boolean; transcription?: TranscriptionItem; error?: string }>;
      desktopListTranscriptions?: (
        page?: number,
        pageSize?: number
      ) => Promise<{
        success: boolean;
        transcriptions?: TranscriptionItem[];
        page?: number;
        pageSize?: number;
        hasMore?: boolean;
        nextPage?: number | null;
        error?: string;
        code?: TranscriptionErrorCode;
        status?: number | null;
      }>;
      desktopGetTranscription?: (id: string) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        audioUrl?: string | null;
        error?: string;
        code?: TranscriptionErrorCode;
        status?: number | null;
      }>;
      desktopUpdateTranscription?: (
        id: string,
        transcript: string,
        expectedRevision: number
      ) => Promise<{
        success: boolean;
        transcription?: TranscriptionItem;
        removed?: boolean;
        error?: string;
        code?: TranscriptionErrorCode;
        status?: number | null;
      }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      onDictionaryUpdated?: (
        callback: (state: DesktopDictionaryState | string[]) => void
      ) => () => void;
      getSnippets?: () => Promise<Array<{ trigger: string; replacement: string }>>;
      setSnippets?: (
        snippets: Array<{ trigger: string; replacement: string }>
      ) => Promise<{ success: boolean }>;
      onSnippetsUpdated?: (
        callback: (snippets: Array<{ trigger: string; replacement: string }>) => void
      ) => () => void;
      setAutoLearnEnabled?: (enabled: boolean) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNote: (id: number) => Promise<NoteItem | null>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
          transcript?: string | null;
          calendar_event_id?: string | null;
          participants?: string | null;
          diarization_enabled?: number | null;
          expected_speaker_count?: number | null;
        }
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportTranscript: (
        noteId: number,
        format: "txt" | "srt" | "json" | "md"
      ) => Promise<{ success: boolean; error?: string }>;
      exportDictionary: (words: string[]) => Promise<{ success: boolean; error?: string }>;
      searchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticSearchNotes: (query: string, limit?: number) => Promise<NoteItem[]>;
      semanticReindexAll: () => Promise<{ success: boolean; indexed?: number; error?: string }>;
      onSemanticReindexProgress: (
        callback: (data: { done: number; total: number }) => void
      ) => () => void;
      updateNoteCloudId: (id: number, cloudId: string) => Promise<NoteItem>;

      // Folder operations
      getFolders: () => Promise<FolderItem[]>;
      createFolder: (
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      getFolderNoteCounts: () => Promise<Array<{ folder_id: number; count: number }>>;

      // Note files (markdown mirror)
      noteFilesSetEnabled?: (
        enabled: boolean,
        customPath?: string,
        options?: { skipRebuild?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;
      noteFilesSetPath?: (path: string) => Promise<{ success: boolean; error?: string }>;
      noteFilesRebuild?: () => Promise<{ success: boolean; error?: string }>;
      noteFilesGetDefaultPath?: () => Promise<string>;
      noteFilesPickFolder?: () => Promise<{ canceled: boolean; path?: string }>;
      showNoteFile?: (noteId: number) => Promise<{ success: boolean }>;
      showFolderInExplorer?: (folderName: string) => Promise<{ success: boolean }>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      getAction: (id: number) => Promise<ActionItem | null>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Audio file operations
      selectAudioFile: (options?: { multiple?: boolean }) => Promise<{
        canceled: boolean;
        filePath?: string;
        filePaths?: string[];
      }>;
      getFileSize?: (filePath: string) => Promise<number>;
      getPathForFile: (file: File) => string;

      // URL audio download
      downloadUrlAudio: (
        url: string,
        downloadId?: string
      ) => Promise<
        | {
            success: true;
            tempPath: string;
            title: string;
            durationSeconds: number | null;
            sizeBytes: number;
          }
        | { success: false; error: string; code?: string }
      >;
      cancelUrlDownload: (downloadId?: string) => Promise<{ success: boolean }>;
      deleteTempFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      onUrlDownloadProgress?: (
        callback: (data: {
          stage: "resolving" | "downloading" | "ready";
          percent: number;
          title?: string;
          downloadId?: string;
        }) => void
      ) => () => void;

      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionUpdated?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;
      onDictationComplete?: (callback: (payload: { text: string }) => void) => () => void;

      getUiLanguage: () => Promise<string>;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        cleanupProvider: string;
        cleanupModel?: string;
        dictationAgentProvider: string;
        dictationAgentModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: (silent?: boolean) => Promise<boolean>;
      promptAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // GPU acceleration for local intelligence models
      listGpus?: () => Promise<GpuDevice[]>;
      setGpuDeviceIndex?: (purpose: "intelligence", uuid: string) => Promise<{ success: boolean }>;
      getGpuDeviceIndex?: (purpose: "intelligence") => Promise<string>;
      detectGpu: () => Promise<GpuInfo>;

      // Local AI model management
      modelGetAll: () => Promise<LocalLLMModelStatus[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCheckRuntime: () => Promise<{
        available: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (
        callback: (event: any, data: LocalLLMDownloadProgressEvent) => void
      ) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;

      // Enterprise reasoning (Bedrock, Azure, Vertex)
      processEnterpriseReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string; retryable?: boolean }>;
      enterpriseStreamStart?: (payload: {
        streamId: string;
        provider: string;
        modelId: string;
        config: Record<string, string>;
        options: Record<string, unknown>;
      }) => Promise<{ success: boolean; error?: string }>;
      enterpriseStreamCancel?: (streamId: string) => Promise<void>;
      onEnterpriseStreamPart?: (
        callback: (payload: {
          streamId: string;
          part?: unknown;
          done?: boolean;
          error?: string;
        }) => void
      ) => () => void;
      listBedrockModels?: (config: Record<string, string>) => Promise<{
        success: boolean;
        models?: Array<{ value: string; label: string; vendor: string }>;
        error?: string;
      }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // llama-server
      llamaServerStart: (
        modelId: string
      ) => Promise<{ success: boolean; port?: number; error?: string }>;
      llamaServerStop: () => Promise<{ success: boolean; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;
      llamaGpuReset: () => Promise<{ success: boolean; error?: string }>;
      detectVulkanGpu?: () => Promise<VulkanGpuResult>;
      getLlamaVulkanStatus?: () => Promise<LlamaVulkanStatus>;
      downloadLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      cancelLlamaVulkanDownload?: () => Promise<{ success: boolean }>;
      deleteLlamaVulkanBinary?: () => Promise<{
        success: boolean;
        deletedCount?: number;
        error?: string;
      }>;
      onLlamaVulkanDownloadProgress?: (
        callback: (data: LlamaVulkanDownloadProgress) => void
      ) => () => void;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      snapToMeetingMode: () => Promise<void>;
      restoreFromMeetingMode: () => Promise<void>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      captureTargetPid: () => Promise<number | null>;
      setNotificationInteractivity: (interactive: boolean) => Promise<void>;
      getRecordingIslandSupport?: () => Promise<boolean>;

      // App management
      cleanupApp: () => Promise<{ success: boolean; message: string; errors?: string[] }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getPostMigrationState: () => Promise<{ justMigrated: boolean }>;
      getOAuthProtocolRegistered: () => Promise<boolean>;
      getOAuthProtocol: () => Promise<string>;
      markBundleMigrated: () => Promise<void>;
      markBundleMigrationDismissed: () => Promise<void>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (enabled: boolean) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: () => Promise<{
        isUsingGnome: boolean;
        isUsingHyprland: boolean;
        isUsingNativeShortcut: boolean;
        supportsPushToTalk: boolean;
      }>;
      getHyprlandConfigStatus?: () => Promise<{ canWrite: boolean; path: string } | null>;

      // Wayland paste diagnostics
      getYdotoolStatus?: () => Promise<{
        isLinux: boolean;
        isWayland: boolean;
        hasYdotool: boolean;
        hasYdotoold: boolean;
        daemonRunning: boolean;
        hasService: boolean;
        hasUinput: boolean;
        hasUdevRule: boolean;
        hasGroup: boolean;
        isNixOS: boolean;
        allGood: boolean;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;
      onSettingUpdated?: (callback: (data: { key: string; value: unknown }) => void) => () => void;
      onDictationKeyActive?: (callback: (key: string) => void) => () => void;
      onLinuxPttPermissionDenied?: (callback: () => void) => () => void;

      // Settings shortcut (Cmd+, / Ctrl+,)
      onShowSettings?: (callback: () => void) => () => void;

      // Accessibility permission events (macOS)
      onAccessibilityMissing?: (callback: () => void) => () => void;
      checkAccessibilityTrusted?: () => Promise<boolean>;

      getTinfoilChatModels?: () => Promise<TinfoilCatalogModel[]>;

      // Enterprise provider key persistence
      getBedrockRegion?: () => Promise<string | null>;
      saveBedrockRegion?: (value: string) => Promise<void>;
      getBedrockProfile?: () => Promise<string | null>;
      saveBedrockProfile?: (value: string) => Promise<void>;
      getAzureEndpoint?: () => Promise<string | null>;
      saveAzureEndpoint?: (value: string) => Promise<void>;
      getAzureDeployment?: () => Promise<string | null>;
      saveAzureDeployment?: (value: string) => Promise<void>;
      getAzureApiVersion?: () => Promise<string | null>;
      saveAzureApiVersion?: (value: string) => Promise<void>;
      getVertexProject?: () => Promise<string | null>;
      saveVertexProject?: (value: string) => Promise<void>;
      getVertexLocation?: () => Promise<string | null>;
      saveVertexLocation?: (value: string) => Promise<void>;
      testEnterpriseConnection?: (
        provider: string,
        config: Record<string, string>
      ) => Promise<{ success: boolean; error?: string; action?: string; copyCommand?: string }>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getActiveDictationKey?: () => Promise<string>;
      getEffectiveDefaultHotkey?: () => Promise<string>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      checkMicrophoneAccess?: () => Promise<{ granted: boolean; status: string }>;
      checkSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      requestSystemAudioAccess?: () => Promise<SystemAudioAccessResult>;
      armDisplayMediaCapture?: () => Promise<{
        success: boolean;
        required?: boolean;
        expiresInMs?: number;
        code?: string;
      }>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openSystemAudioSettings?: () => Promise<{ success: boolean; error?: string }>;
      toggleMediaPlayback?: () => Promise<boolean>;
      pauseMediaPlayback?: () => Promise<boolean>;
      resumeMediaPlayback?: () => Promise<boolean>;
      openModelCacheFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      registerMeetingHotkey?: (hotkey: string) => Promise<{ success: boolean; message?: string }>;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;
      notifyStartMinimizedChanged?: (enabled: boolean) => void;
      notifyPanelStartPositionChanged?: (position: string) => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auth
      authStartBrowser?: (provider?: "google") => Promise<DesktopAuthStatus>;
      authReopenBrowser?: () => Promise<DesktopAuthStatus>;
      authCancelBrowser?: () => Promise<DesktopAuthStatus>;
      authGetStatus?: () => Promise<DesktopAuthStatus>;
      authGetProfile?: () => Promise<DesktopProfile | null>;
      authRefreshSession?: () => Promise<DesktopAuthStatus>;
      authLogout?: () => Promise<{ success: boolean; revoked: boolean }>;
      authDeleteAccount?: () => Promise<{ success: boolean }>;
      onAuthStateChanged?: (callback: (status: DesktopAuthStatus) => void) => () => void;
      onDesktopProtocolError?: (
        callback: (event: unknown, payload: { errorCode?: string }) => void
      ) => () => void;

      // VoiceLab Cloud API
      cloudTranscribe?: (
        audioBuffer: ArrayBuffer,
        opts: {
          language?: string;
          prompt?: string;
          useCase?: string;
          diarization?: boolean;
          mimeType?: string;
          durationSeconds?: number;
          requestId?: string;
        }
      ) => Promise<{
        success: boolean;
        text?: string;
        warning?: string;
        clientTranscriptionId?: string;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        operationId?: string;
        estimatedCredits?: string | null;
        chargedCredits?: string | null;
        balanceCredits?: string;
        isUnlimited?: boolean;
        reservedCredits?: string;
        availableCredits?: string;
        limits?: Record<string, unknown>;
        retryAfterSeconds?: number | null;
        language?: string | null;
        usage?: {
          used_seconds: number;
          limit_seconds: number;
          remaining_seconds: number;
          usage_window: "hour" | "day";
        } | null;
        requestId?: string | null;
        serverCode?: string | null;
        status?: number | null;
        fields?: Record<string, unknown> | null;
        max_duration_seconds?: number;
        error?: string;
        code?: string;
      }>;
      cancelCloudTranscribe?: (requestId: string) => Promise<{ success: boolean }>;
      cloudReason?: (
        text: string,
        opts: {
          model?: string;
          agentName?: string;
          customDictionary?: string[];
          customPrompt?: string;
          systemPrompt?: string;
          promptMode?: "cleanup";
          language?: string;
          locale?: string;
        }
      ) => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        provider?: string;
        promptMode?: string;
        matchType?: string;
        error?: string;
        code?: string;
      }>;
      cloudStreamingUsage?: (
        text: string,
        audioDurationSeconds: number,
        opts?: {
          sendLogs?: boolean;
          sttProvider?: string;
          sttModel?: string;
          sttProcessingMs?: number;
          sttLanguage?: string;
          audioSizeBytes?: number;
          audioFormat?: string;
          clientTotalMs?: number;
        }
      ) => Promise<{
        success: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        error?: string;
        code?: string;
      }>;
      cloudHealthCheck?: () => Promise<{
        ok: boolean;
        status?: number;
        code?: string;
        messageKey?: string;
      }>;
      desktopSubscription?: () => Promise<{
        success: boolean;
        entitlement?: {
          active: boolean;
          planId: string | null;
          planName: string | null;
          usageWindow: "day" | null;
          usageLimitSeconds: number;
          usedSeconds: number;
          reservedSeconds: number;
          remainingSeconds: number;
          windowStartsAt: string | null;
          resetsAt: string | null;
        };
        error?: string;
        code?: string;
        status?: number | null;
        requestId?: string | null;
      }>;
      onDesktopUsageRefresh?: (
        callback: (payload: { reason: "billing-complete" | "app-active" }) => void
      ) => () => void;
      openVoiceLabBilling?: (
        source?: "dictate" | "desktop"
      ) => Promise<{ success: boolean; error?: string }>;
      cloudCheckout?: (opts?: {
        plan?: "monthly" | "annual";
        tier?: "pro" | "business";
      }) => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudBillingPortal?: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudSwitchPlan?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;
      cloudPreviewSwitch?: (opts: {
        plan: "monthly" | "annual";
        tier: "pro" | "business";
      }) => Promise<{
        success: boolean;
        immediateAmount?: number;
        currency?: string;
        currentPriceAmount?: number;
        currentInterval?: string;
        newPriceAmount?: number;
        newInterval?: string;
        nextBillingDate?: string;
        alreadyOnPlan?: boolean;
        error?: string;
      }>;
      workspaceApiRequest?: (opts: {
        method?: "GET" | "POST" | "PATCH" | "DELETE";
        path: string;
        body?: unknown;
      }) => Promise<{
        success: boolean;
        data?: unknown;
        error?: string;
        code?: string;
        status?: number;
      }>;

      // Cloud audio file transcription
      transcribeAudioFileCloud?: (
        filePath: string,
        options?: { language?: string | null }
      ) => Promise<{
        success: boolean;
        text?: string;
        warning?: string;
        error?: string;
        code?: string;
      }>;

      onUploadTranscriptionProgress?: (
        callback: (data: { stage: string; chunksTotal: number; chunksCompleted: number }) => void
      ) => () => void;

      // Main-process provider boundary. Renderer code can select providers and
      // submit work, but it cannot read stored credentials.
      providerCredentialStatus?: () => Promise<{
        credentials: Record<string, boolean>;
      }>;
      providerSaveCredential?: (
        credential: string,
        value: string
      ) => Promise<{ success: boolean; configured?: boolean; error?: string }>;
      providerSaveEndpoint?: (
        provider: "custom" | "lan",
        endpoint: string
      ) => Promise<{ success: boolean; endpoint?: string; error?: string }>;
      providerListModels?: (provider: "openai" | "openrouter" | "custom" | "lan") => Promise<{
        success: boolean;
        models?: Array<{ id: string; ownedBy?: string; description?: string }>;
        error?: string;
      }>;
      providerReason?: (payload: {
        provider: string;
        model: string;
        text: string;
        config?: Record<string, unknown>;
      }) => Promise<{ success: boolean; text?: string; error?: string }>;
      providerStreamStart?: (payload: {
        streamId: string;
        provider: string;
        modelId: string;
        config?: Record<string, unknown>;
        options: Record<string, unknown>;
      }) => Promise<{ success: boolean; error?: string }>;
      providerStreamCancel?: (streamId: string) => Promise<{ success: boolean; error?: string }>;
      onProviderStreamPart?: (
        callback: (payload: {
          streamId: string;
          part?: unknown;
          done?: boolean;
          error?: string;
        }) => void
      ) => () => void;
      // Usage limit events
      notifyLimitReached?: (data: {
        wordsUsed?: number;
        limit?: number;
        availableCredits?: string;
        requiredCredits?: string;
      }) => void;
      onLimitReached?: (
        callback: (data: { wordsUsed: number; limit: number }) => void
      ) => () => void;

      // Workspace invitation deep link
      onWorkspaceInvitationToken?: (callback: (token: string) => void) => () => void;

      // Referral stats
      getReferralStats?: () => Promise<{
        referralCode: string;
        referralLink: string;
        totalReferrals: number;
        completedReferrals: number;
        pendingReferrals: number;
        totalMonthsEarned: number;
        referrals: Array<{
          id: string;
          email: string;
          name: string;
          status: "pending" | "completed" | "rewarded";
          created_at: string;
          first_payment_at: string | null;
          words_used: number;
        }>;
      }>;

      sendReferralInvite?: (email: string) => Promise<{
        success: boolean;
        invite: {
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
        };
      }>;

      getReferralInvites?: () => Promise<{
        invites: Array<{
          id: string;
          recipientEmail: string;
          status: "sent" | "failed" | "opened" | "converted";
          sentAt: string;
          openedAt?: string;
          convertedAt?: string;
        }>;
      }>;

      // Agent Mode
      updateAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      updateVoiceAgentHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getVoiceAgentKey?: () => Promise<string>;
      updateTranslationHotkey?: (hotkey: string) => Promise<{ success: boolean; message: string }>;
      getTranslationKey?: () => Promise<string>;
      getAgentKey?: () => Promise<string>;
      saveAgentKey?: (key: string) => Promise<void>;
      createAgentConversation?: (
        title: string,
        noteId?: number
      ) => Promise<{
        id: number;
        title: string;
        note_id?: number | null;
        created_at: string;
        updated_at: string;
      }>;
      getConversationsForNote?: (
        noteId: number,
        limit?: number
      ) => Promise<
        Array<{
          id: number;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }>
      >;
      getAgentConversations?: (limit?: number) => Promise<
        Array<{
          id: number;
          title: string;
          archived_at?: string;
          cloud_id?: string;
          client_conversation_id?: string;
          created_at: string;
          updated_at: string;
        }>
      >;
      getAgentConversation?: (id: number) => Promise<{
        id: number;
        title: string;
        archived_at?: string;
        cloud_id?: string;
        created_at: string;
        updated_at: string;
        messages: Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>;
      } | null>;
      deleteAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationTitle?: (id: number, title: string) => Promise<{ success: boolean }>;
      addAgentMessage?: (
        conversationId: number,
        role: "user" | "assistant" | "system",
        content: string,
        metadata?: Record<string, unknown>
      ) => Promise<{
        id: number;
        conversation_id: number;
        role: string;
        content: string;
        metadata?: string;
        created_at: string;
      }>;
      getAgentMessages?: (conversationId: number) => Promise<
        Array<{
          id: number;
          conversation_id: number;
          role: "user" | "assistant" | "system";
          content: string;
          metadata?: string;
          created_at: string;
        }>
      >;
      getAgentConversationsWithPreview?: (
        limit?: number,
        offset?: number,
        includeArchived?: boolean
      ) => Promise<ConversationPreview[]>;
      searchAgentConversations?: (query: string, limit?: number) => Promise<ConversationPreview[]>;
      archiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      unarchiveAgentConversation?: (id: number) => Promise<{ success: boolean }>;
      updateAgentConversationCloudId?: (
        id: number,
        cloudId: string
      ) => Promise<{ success: boolean }>;
      semanticSearchConversations?: (
        query: string,
        limit?: number
      ) => Promise<ConversationPreview[]>;

      // Agent overlay
      resizeAgentWindow?: (width: number, height: number) => Promise<void>;
      getAgentWindowBounds?: () => Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>;
      setAgentWindowBounds?: (x: number, y: number, width: number, height: number) => Promise<void>;
      hideAgentOverlay?: () => Promise<void>;
      onAgentStartRecording?: (callback: () => void) => () => void;
      onAgentStopRecording?: (callback: () => void) => () => void;
      onAgentToggleRecording?: (callback: () => void) => () => void;

      // Agent cloud streaming (event-based)
      startAgentStream?: (
        messages: Array<{ role: string; content: string | Array<unknown> }>,
        opts?: {
          systemPrompt?: string;
          tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        }
      ) => void;
      onAgentStreamChunk?: (
        callback: (chunk: {
          type: "content" | "tool_call" | "done";
          text?: string;
          id?: string;
          name?: string;
          arguments?: string;
          finishReason?: string;
        }) => void
      ) => () => void;
      onAgentStreamError?: (
        callback: (error: { error: string; code?: string }) => void
      ) => () => void;
      onAgentStreamEnd?: (callback: () => void) => () => void;

      // Agent cloud tools
      agentOpenNote?: (noteId: number) => Promise<{ success: boolean; error?: string }>;
      agentWebSearch?: (
        query: string,
        numResults?: number
      ) => Promise<{
        success: boolean;
        results?: Array<{
          title: string;
          url: string;
          text: string;
          publishedDate?: string;
        }>;
        error?: string;
      }>;

      // Google Calendar
      gcalStartOAuth?: () => Promise<{ success: boolean; email?: string; error?: string }>;
      gcalDisconnect?: (email?: string) => Promise<{ success: boolean; error?: string }>;
      gcalGetConnectionStatus?: () => Promise<{
        connected: boolean;
        accounts: Array<{ email: string }>;
        email: string | null;
      }>;
      gcalGetCalendars?: () => Promise<{ success: boolean; calendars: any[] }>;
      gcalSetCalendarSelection?: (
        calendarId: string,
        isSelected: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      gcalSetPrimaryOnly?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      gcalSyncEvents?: () => Promise<{ success: boolean; error?: string }>;
      gcalGetUpcomingEvents?: (
        windowMinutes?: number
      ) => Promise<{ success: boolean; events: any[] }>;
      gcalGetEvent?: (eventId: string) => Promise<{
        success: boolean;
        event: {
          id: string;
          summary: string | null;
          start_time: string;
          end_time: string;
          attendees_count: number;
          attendees: string | null;
        } | null;
      }>;

      // Contacts
      searchContacts: (query: string) => Promise<{
        success: boolean;
        contacts: Array<{ email: string; display_name: string | null }>;
      }>;
      upsertContact: (contact: {
        email: string;
        displayName?: string | null;
      }) => Promise<{ success: boolean }>;
      getMD5Hash: (text: string) => Promise<string>;

      // Meeting transcription (streaming, dual-channel)
      meetingTranscriptionPrepare?: (options: {
        provider?: string;
        model?: string;
        language?: string;
      }) => Promise<{ success: boolean; alreadyPrepared?: boolean; error?: string }>;
      meetingTranscriptionStart?: (options: {
        provider?: string;
        model?: string;
        language?: string;
        noteId?: number | null;
        systemAudioCaptureEnabled?: boolean;
      }) => Promise<{
        success: boolean;
        error?: string;
        systemAudioMode?: SystemAudioMode;
        systemAudioStrategy?: SystemAudioStrategy;
        oneOnOneAttendee?: { displayName: string; email: string | null } | null;
      }>;
      meetingTranscriptionSend?: (buffer: ArrayBuffer, source: "mic" | "system") => void;
      meetingTranscriptionSetSystemAudioEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean }>;
      meetingTranscriptionStop?: () => Promise<{
        success: boolean;
        transcript?: string;
        diarizationSessionId?: string;
        error?: string;
      }>;
      meetingTranscriptionCancel?: () => Promise<{
        success: boolean;
        reason?: "recording-active";
      }>;
      onMeetingTranscriptionSegment?: (
        callback: (data: {
          text: string;
          source: "mic" | "system";
          type: "partial" | "final" | "retract";
          timestamp?: number;
        }) => void
      ) => () => void;
      onMeetingSpeakerIdentified?: (
        callback: (data: {
          speakerId: string;
          displayName?: string | null;
          startTime: number;
          endTime: number;
        }) => void
      ) => () => void;
      onMeetingSpeakersMerged?: (
        callback: (
          merges: Array<{
            keep: string;
            remove: string;
            displayName?: string | null;
            similarity: number;
          }>
        ) => void
      ) => () => void;
      onMeetingTranscriptionError?: (callback: (error: string) => void) => () => void;

      // Speaker diarization
      downloadDiarizationModels?: () => Promise<{ success: boolean; error?: string }>;
      getDiarizationModelStatus?: () => Promise<{
        available: boolean;
        modelsDownloaded: boolean;
      }>;
      deleteDiarizationModels?: () => Promise<{ success: boolean }>;
      cancelDiarizationDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      mergeSpeakerText?: (
        segments: Array<{ start: number; end: number; speaker: string }>,
        text: string,
        duration: number
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      diarizeAudioFile?: (
        filePath: string,
        options?: { numSpeakers?: number; threshold?: number }
      ) => Promise<{
        success: boolean;
        segments?: Array<{ start: number; end: number; speaker: string }>;
        error?: string;
      }>;
      onDiarizationDownloadProgress?: (callback: (data: any) => void) => () => void;
      onMeetingDiarizationComplete?: (
        callback: (data: {
          sessionId?: string;
          segments: Array<{
            id: string;
            text: string;
            source: "mic" | "system";
            timestamp?: number;
            speaker?: string;
            speakerName?: string;
            speakerIsPlaceholder?: boolean;
            suggestedName?: string;
            suggestedProfileId?: number;
            speakerStatus?: "provisional" | "confirmed" | "suggested" | "locked";
            speakerLocked?: boolean;
            speakerLockSource?: "user" | "diarization" | "suggestion";
          }>;
          speakerEmbeddings?: Record<string, number[]> | null;
        }) => void
      ) => () => void;

      // Speaker name mapping
      getSpeakerMappings?: (noteId: number) => Promise<
        Array<{
          note_id: number;
          speaker_id: string;
          profile_id: number | null;
          display_name: string;
        }>
      >;
      setSpeakerMapping?: (
        noteId: number,
        speakerId: string,
        displayName: string,
        email?: string | null,
        profileId?: number | null
      ) => Promise<{ success: boolean; profileId: number | null }>;
      removeSpeakerMapping?: (noteId: number, speakerId: string) => Promise<{ success: boolean }>;
      getSpeakerProfiles?: () => Promise<
        Array<{
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
          created_at: string;
          updated_at: string;
        }>
      >;
      attachSpeakerEmail?: (
        profileId: number,
        email: string | null
      ) => Promise<{
        success: boolean;
        error?: string;
        profile?: {
          id: number;
          display_name: string;
          email: string | null;
          sample_count: number;
        };
      }>;
      saveNoteSpeakerEmbeddings?: (
        noteId: number,
        embeddings: Record<string, number[]>
      ) => Promise<{ success: boolean }>;

      // Google Calendar event listeners
      onGcalConnectionChanged?: (callback: (data: any) => void) => () => void;
      onGcalEventsSynced?: (callback: (data: any) => void) => () => void;

      meetingDetectionGetPreferences?: () => Promise<{ success: boolean; preferences?: any }>;
      meetingDetectionSetPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      syncNotificationPreferences?: (
        prefs: Record<string, boolean>
      ) => Promise<{ success: boolean }>;
      setSpeakerDiarizationEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; error?: string }>;
      setMeetingSessionSpeakerConfig?: (config: {
        enabled: boolean;
        expectedCount: number;
      }) => Promise<{ success: boolean; error?: string }>;
      getWhisperVadConfig?: () => Promise<{
        success: boolean;
        config?: {
          dictationSileroEnabled: boolean;
          noteRecordingSileroEnabled: boolean;
          meetingSileroEnabled: boolean;
          threshold: number;
          minSpeechDurationMs: number;
          minSilenceDurationMs: number;
          maxSpeechDurationS: number;
          speechPadMs: number;
          samplesOverlap: number;
        };
        error?: string;
      }>;
      setWhisperVadConfig?: (config: {
        dictationSileroEnabled?: boolean;
        noteRecordingSileroEnabled?: boolean;
        meetingSileroEnabled?: boolean;
        threshold?: number;
        minSpeechDurationMs?: number;
        minSilenceDurationMs?: number;
        maxSpeechDurationS?: number;
        speechPadMs?: number;
        samplesOverlap?: number;
      }) => Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }>;
      onMeetingNotificationData?: (callback: (data: any) => void) => () => void;
      getMeetingNotificationData?: () => Promise<any>;
      meetingNotificationReady?: () => Promise<void>;
      meetingNotificationRespond?: (
        detectionId: string,
        action: string
      ) => Promise<{ success: boolean }>;
      joinCalendarMeeting?: (eventId: string) => Promise<{ success: boolean }>;
      getPendingMeetingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number;
        event: any;
        trigger?: "hotkey" | "manual" | "calendar-join";
      } | null>;
      onMeetingNoteNavigationPending?: (callback: () => void) => () => void;
      getPendingNoteNavigation?: () => Promise<{
        noteId: number;
        folderId: number | null;
      } | null>;
      onNoteNavigationPending?: (callback: () => void) => () => void;
      onPreviewText?: (callback: (text: string) => void) => () => void;
      onPreviewAppend?: (callback: (text: string) => void) => () => void;
      onPreviewHold?: (callback: (payload: { showCleanup: boolean }) => void) => () => void;
      onPreviewResult?: (callback: (payload: { text: string }) => void) => () => void;
      onPreviewHide?: (callback: () => void) => () => void;
      stopDictationPreview?: (opts?: {
        showCleanup?: boolean;
        flushed?: boolean;
      }) => Promise<{ success: boolean; streamed?: boolean; text?: string }>;
      dismissDictationPreview?: () => Promise<{ success: boolean }>;
      completeDictationPreview?: (payload: { text?: string }) => Promise<{ success: boolean }>;
      hideDictationPreview?: () => Promise<{ success: boolean }>;
      resizeTranscriptionPreviewWindow?: (
        width: number,
        height: number
      ) => Promise<{
        success: boolean;
        bounds?: { x: number; y: number; width: number; height: number };
      }>;
      // VoiceLab sync v2 operations
      getDictionaryState?: () => Promise<DesktopDictionaryState>;
      createDictionaryEntry?: (input: {
        displayForm: string;
        language?: string;
        replacement?: string | null;
        pronunciation?: string | null;
        context?: string | null;
        source?: "manual" | "learned";
      }) => Promise<{
        entry: DesktopDictionaryEntry;
        duplicate: boolean;
        state: DesktopDictionaryState;
      }>;
      updateDictionaryEntry?: (
        id: string,
        input: Partial<{
          displayForm: string;
          language: string;
          replacement: string | null;
          pronunciation: string | null;
          context: string | null;
          source: "manual" | "learned";
        }>
      ) => Promise<{ entry: DesktopDictionaryEntry; state: DesktopDictionaryState }>;
      deleteDictionaryEntry?: (
        id: string
      ) => Promise<{ deleted: boolean; state: DesktopDictionaryState }>;
      decideLegacyDictionary?: (
        decision: "attach" | "keep_local"
      ) => Promise<DesktopDictionaryState>;
      desktopSyncBootstrap?: () => Promise<DesktopDictionaryState>;
      desktopSyncSetPreferences?: (
        preferences: Record<string, unknown>
      ) => Promise<DesktopDictionaryState>;
      desktopSyncRun?: (options?: {
        pull?: boolean;
        maxPushBatches?: number;
      }) => Promise<{ success: boolean; state?: DesktopDictionaryState; code?: string }>;
      desktopSyncPause?: () => Promise<{ success: boolean }>;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
