const crypto = require("crypto");
const authLogger = require("./authLogger");

const CLIENT_ID = "voicelab-desktop";
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const SUPPORTED_LANGUAGES = new Set(["uz", "en", "ru"]);
const CANONICAL_AUDIO_UPLOADS = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/mp4", "m4a"],
  ["audio/aac", "aac"],
  ["audio/ogg", "ogg"],
  ["audio/webm", "webm"],
  ["audio/flac", "flac"],
  ["audio/aiff", "aiff"],
  ["audio/amr", "amr"],
  ["audio/3gpp", "3gp"],
  ["audio/caf", "caf"],
  ["audio/x-ms-wma", "wma"],
]);
const DESKTOP_STT_PATH = ["", "v1", "desktop", "stt"].join("/");
const DESKTOP_USAGE_PATH = ["", "v1", "desktop", "usage"].join("/");
const DESKTOP_PROFILE_PATH = ["", "v1", "desktop", "me"].join("/");
const DESKTOP_TRANSCRIPTIONS_PATH = ["", "v1", "desktop", "transcriptions"].join("/");
const DESKTOP_ONBOARDING_PATH = ["", "v1", "desktop", "onboarding"].join("/");
const PROFILE_CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,256}$/;
const STATUS_CODE = {
  400: "INVALID_REQUEST",
  401: "AUTH_EXPIRED",
  402: "ENTITLEMENT_REQUIRED",
  403: "ENTITLEMENT_REQUIRED",
  409: "IDEMPOTENCY_CONFLICT",
  413: "AUDIO_LIMIT_EXCEEDED",
  422: "AUDIO_INVALID",
  429: "RATE_LIMITED",
  500: "SERVICE_UNAVAILABLE",
  502: "SERVICE_UNAVAILABLE",
  503: "SERVICE_UNAVAILABLE",
  504: "SERVICE_UNAVAILABLE",
};

function normalizeErrorCode(status, body) {
  const serverCode = String(
    body?.error?.code || body?.code || body?.error_code || ""
  ).toUpperCase();
  const goCode = {
    INVALID_MULTIPART: "INVALID_REQUEST",
    VALIDATION_ERROR: "INVALID_REQUEST",
    INVALID_IDEMPOTENCY_KEY: "INVALID_REQUEST",
    UNAUTHENTICATED: "AUTH_EXPIRED",
    INVALID_DESKTOP_TOKEN: "AUTH_EXPIRED",
    DESKTOP_SUBSCRIPTION_REQUIRED: "ENTITLEMENT_REQUIRED",
    INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
    AUDIO_TOO_LARGE: "AUDIO_LIMIT_EXCEEDED",
    AUDIO_TOO_LONG: "AUDIO_LIMIT_EXCEEDED",
    UNSUPPORTED_AUDIO_FORMAT: "AUDIO_INVALID",
    UNSUPPORTED_LANGUAGE: "AUDIO_LANGUAGE_UNSUPPORTED",
    INVALID_AUDIO: "AUDIO_INVALID",
    NO_SPEECH_DETECTED: "NO_SPEECH_DETECTED",
    CONCURRENT_DICTATION: "CONCURRENCY_LIMIT",
    DESKTOP_USAGE_LIMIT_REACHED: "DAILY_CAP_REACHED",
    DAILY_DICTATION_LIMIT_REACHED: "DAILY_CAP_REACHED",
    RATE_LIMITED: "RATE_LIMITED",
    STT_OVERLOADED: "RATE_LIMITED",
    DESKTOP_STT_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    DESKTOP_STT_TIMEOUT: "SERVICE_UNAVAILABLE",
    ORIGIN_FORBIDDEN: "SERVICE_UNAVAILABLE",
    STT_NOT_AVAILABLE: "ENTITLEMENT_REQUIRED",
    STT_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    LONG_STT_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    DESKTOP_TRANSCRIPT_CONFLICT: "DESKTOP_TRANSCRIPT_CONFLICT",
    DESKTOP_TRANSCRIPTION_NOT_FOUND: "DESKTOP_TRANSCRIPTION_NOT_FOUND",
    DESKTOP_TRANSCRIPTIONS_UNAVAILABLE: "DESKTOP_TRANSCRIPTIONS_UNAVAILABLE",
    DESKTOP_ONBOARDING_NOT_FOUND: "DESKTOP_ONBOARDING_NOT_FOUND",
    DESKTOP_ONBOARDING_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  }[serverCode];
  if (goCode) return goCode;
  if (serverCode.startsWith("SYNC_")) return serverCode;
  if (status === 403) return "ENTITLEMENT_REQUIRED";
  if (status === 409)
    return serverCode === "DESKTOP_DEVICE_LIMIT" ? "DEVICE_LIMIT" : "IDEMPOTENCY_CONFLICT";
  if (status === 413) return "AUDIO_LIMIT_EXCEEDED";
  if (status === 422)
    return serverCode === "STT_DURATION_LIMIT_EXCEEDED" ? "AUDIO_LIMIT_EXCEEDED" : "AUDIO_INVALID";
  if (status === 429) {
    if (serverCode === "STT_CONCURRENCY_LIMIT") return "CONCURRENCY_LIMIT";
    if (serverCode === "STT_DAILY_LIMIT") return "DAILY_CAP_REACHED";
    return "RATE_LIMITED";
  }
  return STATUS_CODE[status] || serverCode || "BACKEND_FAILED";
}

class VoiceLabApiError extends Error {
  constructor({ code, message, status = null, retryAfterSeconds = null, details = {} }) {
    super(publicMessage(message) || code || "VoiceLab request failed");
    this.name = "VoiceLabApiError";
    this.code = code || "BACKEND_FAILED";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details && typeof details === "object" ? details : {};
  }
  toPublic() {
    const serverError =
      this.details?.error && typeof this.details.error === "object" ? this.details.error : {};
    const details = {
      ...(serverError.details || {}),
      ...(serverError.fields || {}),
      ...(this.details.details || {}),
      ...this.details,
    };
    const result = {
      success: false,
      error: this.message,
      code: this.code,
      serverCode: serverError.code || details.code || null,
      requestId: safeRequestId(details.requestId || details.request_id),
      hint: details.hint || serverError.hint || null,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
      fields: serverError.fields || null,
    };
    for (const key of [
      "required",
      "available",
      "required_credits",
      "available_credits",
      "max_duration_seconds",
      "max_concurrent_operations",
      "rolling_24h_credit_limit",
      "rolling_24h_credits_used",
      "operation_id",
      "retry_requires_confirmation",
    ])
      if (details[key] != null) result[key] = details[key];
    return result;
  }
}

function retryAfterSeconds(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

function publicMessage(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 500) || null
    : null;
}

function authSessionContext(authManager) {
  const metadata = authManager?.getSessionMetadata?.() || {};
  return {
    accountId: metadata.accountId == null ? null : String(metadata.accountId),
    sessionId: metadata.sessionId == null ? null : String(metadata.sessionId),
  };
}

function sameAuthSessionContext(expected, current) {
  if (!expected || !current) return false;
  if (expected.sessionId || current.sessionId) {
    return (
      Boolean(expected.sessionId) &&
      expected.sessionId === current.sessionId &&
      expected.accountId === current.accountId
    );
  }
  return Boolean(expected.accountId) && expected.accountId === current.accountId;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized.slice(0, 128);
  }
  return null;
}

function safeRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function safeProfileText(value, maxLength) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function safeProfileAvatarUrl(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

// These URLs are short-lived playback capabilities. They are validated before
// use but deliberately never passed to the database or other persistent state.
function safeDesktopAudioUrl(value) {
  return safeProfileAvatarUrl(value);
}

function safeDesktopTranscriptionId(value) {
  return typeof value === "string" && /^dst_[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
}

function safeTranscriptText(value) {
  return typeof value === "string" &&
    value.length <= 1_000_000 &&
    value.trim().length > 0 &&
    !value.includes("\0")
    ? value
    : null;
}

function validRfc3339(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function invalidResponse(resource, requestId = null) {
  throw new VoiceLabApiError({
    code: "BACKEND_RESPONSE_INVALID",
    message: `VoiceLab returned an invalid ${resource} response.`,
    status: 502,
    details: { request_id: requestId },
  });
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

// Mirrors the closed option sets the server accepts for desktop onboarding.
// Unknown values are dropped on read so the renderer only ever sees choices it
// can render.
const ONBOARDING_ROLES = new Set([
  "developer",
  "founder",
  "product",
  "marketing",
  "sales",
  "operations",
  "student",
  "educator",
  "writer",
  "creator",
  "consultant",
  "legal",
  "healthcare",
  "support",
  "other",
]);
const ONBOARDING_USE_CASES = new Set([
  "messages",
  "emails",
  "documents",
  "notes",
  "ai",
  "coding",
  "posts",
  "other",
]);
const ONBOARDING_WRITING_STYLES = new Set(["casual", "formal", "excited"]);
const ONBOARDING_THEMES = new Set(["light", "dark", "auto"]);
const ONBOARDING_MAX_USE_CASES = 16;

function onboardingChoice(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : "";
}

function onboardingText(value, maxLength) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, maxLength) : "";
}

function normalizeDesktopOnboarding(payload) {
  const root = record(payload);
  const onboarding = record(root.onboarding);
  const requestId = safeRequestId(root.request_id);
  const revision = safeInteger(onboarding.revision, { min: 1 });
  const completedAt = validRfc3339(onboarding.completed_at);
  const updatedAt = validRfc3339(onboarding.updated_at);
  if (!requestId || revision == null || !completedAt || !updatedAt) {
    return invalidResponse("desktop onboarding", requestId);
  }
  const useCases = Array.isArray(onboarding.use_cases)
    ? [...new Set(onboarding.use_cases.filter((value) => ONBOARDING_USE_CASES.has(value)))]
    : [];
  const dictationLanguage = onboardingText(onboarding.dictation_language, 16);
  return {
    role: onboardingChoice(onboarding.role, ONBOARDING_ROLES),
    useCases,
    dictationLanguage: /^[a-z]{2,3}$/.test(dictationLanguage) ? dictationLanguage : "auto",
    writingStyle: onboardingChoice(onboarding.writing_style, ONBOARDING_WRITING_STYLES),
    uiLanguage: onboardingText(onboarding.ui_language, 16),
    theme: onboardingChoice(onboarding.theme, ONBOARDING_THEMES),
    appVersion: safeProfileText(onboarding.app_version, 32) || "",
    platform: onboardingText(onboarding.platform, 16),
    revision,
    completedAt,
    updatedAt,
    requestId,
  };
}

// Builds the exact JSON body for PUT /v1/desktop/onboarding. Empty strings mean
// the user skipped a question; the server stores them as skipped rather than
// inventing an answer.
function desktopOnboardingPayload(input, appVersion) {
  const source = record(input);
  const useCases = Array.isArray(source.useCases)
    ? [...new Set(source.useCases.map((value) => onboardingText(value, 32)).filter(Boolean))].slice(
        0,
        ONBOARDING_MAX_USE_CASES
      )
    : [];
  return {
    role: onboardingText(source.role, 32),
    use_cases: useCases,
    dictation_language: onboardingText(source.dictationLanguage, 16) || "auto",
    writing_style: onboardingText(source.writingStyle, 16),
    ui_language: onboardingText(source.uiLanguage, 16),
    theme: onboardingText(source.theme, 16),
    app_version: typeof appVersion === "string" ? appVersion.trim().slice(0, 32) : "",
    platform: process.platform,
    completed_at: validRfc3339(source.completedAt) || new Date().toISOString(),
  };
}

function normalizeUsage(payload) {
  const usage = record(payload);
  const usedSeconds = usage.used_seconds;
  const limitSeconds = usage.limit_seconds;
  const remainingSeconds = usage.remaining_seconds;
  const usageWindow = usage.usage_window;
  if (
    !Number.isSafeInteger(usedSeconds) ||
    usedSeconds < 0 ||
    !Number.isSafeInteger(limitSeconds) ||
    limitSeconds < 0 ||
    !Number.isSafeInteger(remainingSeconds) ||
    remainingSeconds < 0 ||
    usageWindow !== "day" ||
    remainingSeconds !== Math.max(0, limitSeconds - usedSeconds)
  ) {
    return null;
  }
  return {
    used_seconds: usedSeconds,
    limit_seconds: limitSeconds,
    remaining_seconds: remainingSeconds,
    usage_window: usageWindow,
  };
}

function normalizeDesktopSttResponse(payload) {
  const root = record(payload);
  const usage = normalizeUsage(root.usage);
  const requestId = safeRequestId(root.request_id);
  const canonical =
    typeof root.text === "string" &&
    root.text.length > 0 &&
    root.text.length <= 1_000_000 &&
    !root.text.includes("\0") &&
    SUPPORTED_LANGUAGES.has(root.language) &&
    Number.isSafeInteger(root.duration_ms) &&
    root.duration_ms >= 0 &&
    usage &&
    requestId;
  if (canonical) {
    const id = root.id == null ? null : safeDesktopTranscriptionId(root.id);
    const revision = root.revision == null ? null : safeInteger(root.revision, { min: 1 });
    if (
      (root.id != null && !id) ||
      (root.revision != null && revision == null) ||
      Boolean(id) !== Boolean(revision)
    ) {
      return invalidResponse("transcription", requestId);
    }
    const audioAvailable = root.audio_available === true;
    const savedDictation = id
      ? {
          id,
          revision,
          audio_available: audioAvailable,
          audio_url: audioAvailable ? safeDesktopAudioUrl(root.audio_url) : null,
        }
      : {};
    return {
      text: root.text,
      language: root.language,
      duration_ms: root.duration_ms,
      usage,
      request_id: requestId,
      ...savedDictation,
    };
  }
  return invalidResponse("transcription", requestId);
}

function normalizeDesktopTranscriptionRecord(payload, requestId = null) {
  const root = record(payload);
  const id = safeDesktopTranscriptionId(root.id);
  const transcript = safeTranscriptText(root.transcript ?? root.text);
  const revision = safeInteger(root.revision, { min: 1 });
  const audioAvailable = root.audio_available === true;
  const durationMs =
    root.duration_ms == null ? null : safeInteger(root.duration_ms, { min: 0, max: 86_400_000 });
  const language = root.language == null ? null : safeString(root.language);
  const createdAt = validRfc3339(root.created_at ?? root.timestamp);
  if (!id || !transcript || revision == null || (root.duration_ms != null && durationMs == null)) {
    return invalidResponse("saved transcription", requestId);
  }
  return {
    id,
    transcript,
    revision,
    language,
    durationMs,
    createdAt,
    audioAvailable,
    // Only retained in memory by the caller which opens this one dictation.
    audioUrl: audioAvailable ? safeDesktopAudioUrl(root.audio_url) : null,
  };
}

function desktopRecordBody(payload) {
  const root = record(payload);
  const nested = record(root.transcription);
  if (Object.keys(nested).length) return nested;
  const data = record(root.data);
  return Object.keys(data).length ? data : root;
}

function normalizeDesktopTranscriptionList(payload, { page, pageSize }) {
  const root = record(payload);
  const collection = [root.transcriptions, root.items, root.data].find(Array.isArray);
  const requestId = safeRequestId(root.request_id);
  if (!collection) return invalidResponse("transcription history", requestId);
  const pagination = record(root.pagination);
  const normalizedPage = safeInteger(root.page ?? pagination.page, { min: 1 }) ?? page;
  const normalizedPageSize =
    safeInteger(root.page_size ?? pagination.page_size, { min: 1, max: 50 }) ?? pageSize;
  const nextPage = safeInteger(root.next_page ?? pagination.next_page, { min: normalizedPage + 1 });
  const explicitHasMore = root.has_more ?? pagination.has_more;
  return {
    items: collection.map((item) => normalizeDesktopTranscriptionRecord(item, requestId)),
    page: normalizedPage,
    pageSize: normalizedPageSize,
    hasMore: typeof explicitHasMore === "boolean" ? explicitHasMore : Boolean(nextPage),
    nextPage,
    requestId,
  };
}

function normalizeDesktopUsage(payload) {
  const root = record(payload);
  const rawEntitlement = record(root.desktop_stt);
  const requestId = safeRequestId(root.request_id);
  if (!requestId || typeof rawEntitlement.enabled !== "boolean") {
    return invalidResponse("desktop usage", requestId);
  }

  if (!rawEntitlement.enabled) {
    return {
      entitlement: {
        active: false,
        planId: null,
        planName: null,
        usageWindow: null,
        usageLimitSeconds: 0,
        usedSeconds: 0,
        reservedSeconds: 0,
        remainingSeconds: 0,
        maxRequestSeconds: null,
        windowStartsAt: null,
        resetsAt: null,
      },
      requestId,
    };
  }

  const planId = safeString(rawEntitlement.plan_id);
  const planName = safeString(rawEntitlement.plan_name);
  const usageWindow = rawEntitlement.usage_window;
  const usageLimitSeconds = safeInteger(rawEntitlement.usage_limit_seconds);
  // The Go API currently omits zero-valued counters. Treat an absent counter
  // as zero, but continue rejecting every non-zero malformed value.
  const usedSeconds =
    rawEntitlement.used_seconds == null ? 0 : safeInteger(rawEntitlement.used_seconds);
  const reservedSeconds =
    rawEntitlement.reserved_seconds == null ? 0 : safeInteger(rawEntitlement.reserved_seconds);
  // remaining_seconds is also omitted when it is zero (daily cap reached), so
  // derive it from the other counters whenever the server leaves it out.
  const remainingSeconds =
    rawEntitlement.remaining_seconds == null
      ? Number.isSafeInteger(usageLimitSeconds) &&
        Number.isSafeInteger(usedSeconds) &&
        Number.isSafeInteger(reservedSeconds)
        ? Math.max(0, usageLimitSeconds - usedSeconds - reservedSeconds)
        : null
      : safeInteger(rawEntitlement.remaining_seconds);
  const windowStartsAt = validRfc3339(rawEntitlement.window_starts_at);
  const resetsAt = validRfc3339(rawEntitlement.resets_at);
  const failedChecks = [
    !planId && "plan_id",
    !planName && "plan_name",
    usageWindow !== "day" && "usage_window",
    !Number.isSafeInteger(usageLimitSeconds) && "usage_limit_seconds",
    !Number.isSafeInteger(usedSeconds) && "used_seconds",
    !Number.isSafeInteger(reservedSeconds) && "reserved_seconds",
    !Number.isSafeInteger(remainingSeconds) && "remaining_seconds",
    remainingSeconds !== Math.max(0, usageLimitSeconds - usedSeconds - reservedSeconds) &&
      "remaining_seconds_mismatch",
    !windowStartsAt && "window_starts_at",
    !resetsAt && "resets_at",
    windowStartsAt &&
      resetsAt &&
      Date.parse(resetsAt) <= Date.parse(windowStartsAt) &&
      "window_order",
  ].filter(Boolean);
  if (failedChecks.length > 0) {
    authLogger.warn("Desktop usage response failed validation", {
      requestId,
      failedChecks,
      keys: Object.keys(rawEntitlement),
      usageLimitSeconds: rawEntitlement.usage_limit_seconds,
      usedSeconds: rawEntitlement.used_seconds,
      reservedSeconds: rawEntitlement.reserved_seconds,
      remainingSeconds: rawEntitlement.remaining_seconds,
      usageWindow,
      windowStartsAt: rawEntitlement.window_starts_at,
      resetsAt: rawEntitlement.resets_at,
    });
    return invalidResponse("desktop usage", requestId);
  }

  return {
    entitlement: {
      active: true,
      planId,
      planName,
      usageWindow,
      usageLimitSeconds,
      usedSeconds,
      reservedSeconds,
      remainingSeconds,
      maxRequestSeconds: null,
      windowStartsAt,
      resetsAt,
    },
    requestId,
  };
}

function normalizeDesktopProfile(payload) {
  const root = record(payload);
  const user = record(root.user);
  const requestId = safeRequestId(root.request_id);
  const id = safeProfileText(user.id, 256);
  if (!id || !requestId) return invalidResponse("desktop profile", requestId);

  return {
    user: {
      id,
      displayName: safeProfileText(user.display_name, 256),
      avatarUrl: safeProfileAvatarUrl(user.avatar_url),
    },
    requestId,
  };
}

function composeSignal(externalSignals, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signals = (Array.isArray(externalSignals) ? externalSignals : [externalSignals]).filter(
    Boolean
  );
  const abort = (event) => controller.abort(event?.target?.reason);
  for (const signal of signals) {
    if (signal.aborted) abort({ target: signal });
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      for (const signal of signals) signal.removeEventListener?.("abort", abort);
    },
  };
}

class VoiceLabApiClient {
  constructor({ authManager, apiBaseUrl, appVersion, channel, billingOrigin }) {
    this.authManager = authManager;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.appVersion = appVersion;
    this.channel = channel;
    this.billingOrigin = billingOrigin.replace(/\/+$/, "");
    this.activeDictationOperations = new Map();
    this.sessionAccountId = null;
    this.profileCache = null;
    this.profileRequest = null;
  }

  handleAuthStatus(status) {
    const nextAccountId =
      status?.status === "authenticated" ? this.authManager.getSessionMetadata().accountId : null;
    const accountChanged =
      this.sessionAccountId && nextAccountId && this.sessionAccountId !== nextAccountId;
    if (status?.status !== "authenticated" || accountChanged) {
      for (const operation of this.activeDictationOperations.values()) {
        operation.abortController?.abort();
      }
      this.activeDictationOperations.clear();
      this.profileCache = null;
      this.profileRequest = null;
    }
    this.sessionAccountId = nextAccountId;
  }

  getBillingUrl(source = "dictate") {
    const url = new URL("/app/billing", this.billingOrigin);
    void source;
    url.searchParams.set("source", "desktop");
    return url.toString();
  }

  async authenticatedFetch(pathname, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const routePath = String(pathname).split("?", 1)[0];
    const isDesktopStt = method === "POST" && routePath === DESKTOP_STT_PATH;
    const isDesktopUsage = method === "GET" && routePath === DESKTOP_USAGE_PATH;
    const isDesktopProfile = method === "GET" && routePath === DESKTOP_PROFILE_PATH;
    const isDesktopTranscriptions =
      routePath === DESKTOP_TRANSCRIPTIONS_PATH ||
      routePath.startsWith(`${DESKTOP_TRANSCRIPTIONS_PATH}/`);
    const isDesktopOnboarding = routePath === DESKTOP_ONBOARDING_PATH;
    const isCanonicalDesktopBoundary =
      isDesktopStt ||
      isDesktopUsage ||
      isDesktopProfile ||
      isDesktopTranscriptions ||
      isDesktopOnboarding;
    if (isDesktopStt && options.idempotencyKey) {
      throw new VoiceLabApiError({
        code: "INVALID_REQUEST",
        message: "Desktop STT does not accept an idempotency key.",
        status: 400,
      });
    }
    const initialAuthContext = authSessionContext(this.authManager);
    let authRetried = false;
    let retryAuthContext = null;
    for (;;) {
      let accessToken;
      try {
        accessToken = await this.authManager.getValidAccessToken();
      } catch (error) {
        const terminal =
          [400, 401, 403].includes(Number(error?.httpStatus)) ||
          error?.code === "AUTH_EXPIRED" ||
          error?.code === "AUTH_REQUIRED";
        throw new VoiceLabApiError({
          code: terminal ? error.code || "AUTH_EXPIRED" : "SERVICE_UNAVAILABLE",
          message: terminal
            ? "VoiceLab session expired. Sign in again."
            : "VoiceLab authentication is temporarily unavailable. Try again.",
          status: terminal ? 401 : Number(error?.httpStatus) || null,
        });
      }
      const metadata = this.authManager.getSessionMetadata();
      const timed = composeSignal(options.signals || options.signal, options.timeoutMs || 45_000);
      let response;
      let text;
      try {
        response = await fetch(`${this.apiBaseUrl}${pathname}`, {
          method,
          headers: {
            ...(options.headers || {}),
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(!isCanonicalDesktopBoundary
              ? {
                  "X-VoiceLab-Client": CLIENT_ID,
                  "X-VoiceLab-App-Version": this.appVersion,
                  "X-VoiceLab-Channel": this.channel,
                  "X-VoiceLab-Installation-ID": metadata.installationId,
                  ...(metadata.sessionId ? { "X-VoiceLab-Session-ID": metadata.sessionId } : {}),
                  ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
                }
              : {}),
          },
          body: options.bodyFactory ? options.bodyFactory() : options.body,
          ...(options.cache ? { cache: options.cache } : {}),
          signal: timed.signal,
        });
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
          throw new VoiceLabApiError({
            code: "BACKEND_RESPONSE_INVALID",
            message: "VoiceLab returned an oversized response.",
            status: response.status,
          });
        }
        text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_JSON_RESPONSE_BYTES) {
          throw new VoiceLabApiError({
            code: "BACKEND_RESPONSE_INVALID",
            message: "VoiceLab returned an oversized response.",
            status: response.status,
          });
        }
      } catch (error) {
        if (error instanceof VoiceLabApiError) throw error;
        const externalSignals = (
          Array.isArray(options.signals) ? options.signals : [options.signal]
        ).filter(Boolean);
        if (externalSignals.some((signal) => signal.aborted))
          throw new VoiceLabApiError({ code: "CANCELLED", message: "Request cancelled" });
        throw new VoiceLabApiError({
          code: "SERVICE_UNAVAILABLE",
          message: isDesktopStt
            ? "The dictation result is unknown because the connection ended. Confirm before retrying this recording."
            : "VoiceLab is temporarily unavailable. Try again.",
          details: isDesktopStt ? { retry_requires_confirmation: true } : {},
        });
      } finally {
        timed.cleanup();
      }
      const responseRequestId = safeString(response.headers.get("x-request-id"));
      const responseContentType = String(response.headers.get("content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      let body = null;
      if (text) {
        if (isCanonicalDesktopBoundary && responseContentType !== "application/json") {
          throw new VoiceLabApiError({
            code: "BACKEND_RESPONSE_INVALID",
            message: "VoiceLab returned a non-JSON response.",
            status: response.status,
            details: {
              request_id: safeRequestId(responseRequestId),
              content_type: responseContentType || null,
            },
          });
        }
        try {
          body = JSON.parse(text);
        } catch {
          authLogger.warn("voicelab_response_invalid", {
            errorCode: "BACKEND_RESPONSE_INVALID",
            httpStatus: response.status,
            method,
            path: pathname,
            requestId: safeRequestId(responseRequestId),
            contentType: responseContentType || null,
          });
          throw new VoiceLabApiError({
            code: "BACKEND_RESPONSE_INVALID",
            message: "VoiceLab returned an invalid JSON response.",
            status: response.status,
            details: {
              request_id: safeRequestId(responseRequestId),
              content_type: responseContentType || null,
            },
          });
        }
      }
      if (response.ok) return body;

      const serverAuthCode = body?.error?.code || body?.code || null;
      const refreshableDesktopToken =
        response.status === 401 &&
        isCanonicalDesktopBoundary &&
        serverAuthCode === "invalid_desktop_token";
      if (refreshableDesktopToken && !authRetried) {
        if (!sameAuthSessionContext(initialAuthContext, authSessionContext(this.authManager))) {
          throw new VoiceLabApiError({
            code: "AUTH_ACCOUNT_CHANGED",
            message: "The active VoiceLab session changed during this request.",
            status: 409,
            details: body || {},
          });
        }
        authRetried = true;
        try {
          await this.authManager.refreshSession({ force: true });
        } catch (refreshError) {
          const refreshStatus = Number(refreshError?.httpStatus) || null;
          const terminal =
            [400, 401, 403].includes(refreshStatus) ||
            refreshError?.httpStatus == null ||
            refreshError?.code === "AUTH_EXPIRED" ||
            refreshError?.code === "AUTH_REQUIRED";
          throw new VoiceLabApiError({
            code: terminal
              ? "AUTH_EXPIRED"
              : refreshStatus === 429
                ? "RATE_LIMITED"
                : "SERVICE_UNAVAILABLE",
            message: terminal
              ? "VoiceLab session expired. Sign in again."
              : "VoiceLab authentication is temporarily unavailable. Try again.",
            status: terminal ? 401 : refreshStatus,
            retryAfterSeconds: refreshError?.retryAfterSeconds ?? null,
            details: {
              request_id: refreshError?.requestId || null,
              error: {
                code: refreshError?.code || null,
                fields: refreshError?.fields || null,
              },
            },
          });
        }
        retryAuthContext = authSessionContext(this.authManager);
        if (!sameAuthSessionContext(initialAuthContext, retryAuthContext)) {
          throw new VoiceLabApiError({
            code: "AUTH_ACCOUNT_CHANGED",
            message: "The active VoiceLab session changed during token refresh.",
            status: 409,
            details: body || {},
          });
        }
        continue;
      }
      if (
        refreshableDesktopToken &&
        authRetried &&
        sameAuthSessionContext(retryAuthContext, authSessionContext(this.authManager))
      ) {
        this.authManager.invalidateSession?.({
          code: serverAuthCode,
          message: body?.message || "VoiceLab session expired. Sign in again.",
        });
      }
      const error = new VoiceLabApiError({
        code: normalizeErrorCode(response.status, body),
        message:
          body?.error?.message ||
          (typeof body?.error === "string" ? body.error : null) ||
          body?.detail ||
          body?.message ||
          "VoiceLab request failed",
        status: response.status,
        retryAfterSeconds: retryAfterSeconds(response),
        details: body || {},
      });
      authLogger.warn("voicelab_request_failed", {
        errorCode: error.code,
        serverCode: body?.error?.code || body?.code,
        httpStatus: response.status,
        method,
        path: pathname,
        requestId: body?.request_id || null,
      });
      throw error;
    }
  }

  async getDesktopUsage() {
    const requestContext = authSessionContext(this.authManager);
    const body = await this.authenticatedFetch(DESKTOP_USAGE_PATH, {
      method: "GET",
      timeoutMs: 15_000,
      cache: "no-store",
    });
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    return normalizeDesktopUsage(body);
  }

  async getDesktopProfile() {
    const requestContext = authSessionContext(this.authManager);
    const accountKey = requestContext.accountId || requestContext.sessionId;
    if (!accountKey) {
      throw new VoiceLabApiError({
        code: "AUTH_REQUIRED",
        message: "Authentication required.",
        status: 401,
      });
    }
    if (
      this.profileCache?.accountKey === accountKey &&
      Date.now() - this.profileCache.cachedAt < PROFILE_CACHE_TTL_MS
    ) {
      return this.profileCache.profile;
    }
    if (this.profileRequest?.accountKey === accountKey) return this.profileRequest.promise;

    const request = (async () => {
      const body = await this.authenticatedFetch(DESKTOP_PROFILE_PATH, {
        method: "GET",
        timeoutMs: 15_000,
        cache: "no-store",
      });
      if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
        throw new VoiceLabApiError({
          code: "AUTH_ACCOUNT_CHANGED",
          message: "The active VoiceLab session changed during this request.",
          status: 409,
        });
      }
      const profile = normalizeDesktopProfile(body);
      // Presentation-only data; credentials and usage are never cached here.
      this.profileCache = { accountKey, profile, cachedAt: Date.now() };
      return profile;
    })();
    this.profileRequest = { accountKey, promise: request };
    try {
      return await request;
    } finally {
      if (this.profileRequest?.promise === request) this.profileRequest = null;
    }
  }

  async listDesktopTranscriptions({ page = 1, pageSize = 50 } = {}) {
    const validPage = safeInteger(page, { min: 1, max: 1_000_000 });
    const validPageSize = safeInteger(pageSize, { min: 1, max: 50 });
    if (!validPage || !validPageSize) {
      throw new VoiceLabApiError({
        code: "INVALID_REQUEST",
        message: "Invalid transcription history page.",
        status: 400,
      });
    }
    const requestContext = authSessionContext(this.authManager);
    const body = await this.authenticatedFetch(
      `${DESKTOP_TRANSCRIPTIONS_PATH}?page=${validPage}&page_size=${validPageSize}`,
      { method: "GET", timeoutMs: 15_000, cache: "no-store" }
    );
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    return normalizeDesktopTranscriptionList(body, { page: validPage, pageSize: validPageSize });
  }

  async getDesktopTranscription(id) {
    const transcriptionId = safeDesktopTranscriptionId(id);
    if (!transcriptionId) {
      throw new VoiceLabApiError({
        code: "INVALID_REQUEST",
        message: "Invalid saved transcription.",
        status: 400,
      });
    }
    const requestContext = authSessionContext(this.authManager);
    const body = await this.authenticatedFetch(
      `${DESKTOP_TRANSCRIPTIONS_PATH}/${encodeURIComponent(transcriptionId)}`,
      { method: "GET", timeoutMs: 15_000, cache: "no-store" }
    );
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    const root = record(body);
    return {
      ...normalizeDesktopTranscriptionRecord(
        desktopRecordBody(root),
        safeRequestId(root.request_id)
      ),
      requestId: safeRequestId(root.request_id),
    };
  }

  async updateDesktopTranscription(id, transcript, expectedRevision) {
    const transcriptionId = safeDesktopTranscriptionId(id);
    const validatedTranscript = safeTranscriptText(transcript);
    const revision = safeInteger(expectedRevision, { min: 1 });
    if (!transcriptionId || !validatedTranscript || revision == null) {
      throw new VoiceLabApiError({
        code: "INVALID_REQUEST",
        message: "Invalid transcription edit.",
        status: 400,
      });
    }
    const requestContext = authSessionContext(this.authManager);
    const body = await this.authenticatedFetch(
      `${DESKTOP_TRANSCRIPTIONS_PATH}/${encodeURIComponent(transcriptionId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: validatedTranscript, expected_revision: revision }),
        timeoutMs: 20_000,
        cache: "no-store",
      }
    );
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    const root = record(body);
    return {
      ...normalizeDesktopTranscriptionRecord(
        desktopRecordBody(root),
        safeRequestId(root.request_id)
      ),
      requestId: safeRequestId(root.request_id),
    };
  }

  // Returns the account's saved onboarding answers, or null when the user has
  // never finished desktop onboarding on any installation.
  async getDesktopOnboarding() {
    const requestContext = authSessionContext(this.authManager);
    let body;
    try {
      body = await this.authenticatedFetch(DESKTOP_ONBOARDING_PATH, {
        method: "GET",
        timeoutMs: 15_000,
        cache: "no-store",
      });
    } catch (error) {
      if (
        error instanceof VoiceLabApiError &&
        error.status === 404 &&
        error.code === "DESKTOP_ONBOARDING_NOT_FOUND"
      ) {
        return null;
      }
      throw error;
    }
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    return normalizeDesktopOnboarding(body);
  }

  // Upserts the onboarding answers. Safe to repeat: the server replaces the
  // profile in place and only bumps its revision.
  async saveDesktopOnboarding(input = {}) {
    const requestContext = authSessionContext(this.authManager);
    const body = await this.authenticatedFetch(DESKTOP_ONBOARDING_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desktopOnboardingPayload(input, this.appVersion)),
      timeoutMs: 20_000,
      cache: "no-store",
    });
    if (!sameAuthSessionContext(requestContext, authSessionContext(this.authManager))) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "The active VoiceLab session changed during this request.",
        status: 409,
      });
    }
    return normalizeDesktopOnboarding(body);
  }

  async beginDictation({ audioBuffer, source = "dictate", durationMs = null, language = null }) {
    const requestedLanguage =
      (typeof language === "string" ? language.trim().toLowerCase() : "") || "auto";
    if (requestedLanguage !== "auto" && !SUPPORTED_LANGUAGES.has(requestedLanguage)) {
      throw new VoiceLabApiError({
        code: "AUDIO_LANGUAGE_UNSUPPORTED",
        message: "This language is not available for VoiceLab Cloud.",
        status: 422,
        details: {
          language: requestedLanguage,
          supported_languages: [...SUPPORTED_LANGUAGES],
        },
      });
    }
    const normalizedLanguage = requestedLanguage === "auto" ? "uz" : requestedLanguage;
    if (!Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array))
      throw new VoiceLabApiError({
        code: "INVALID_REQUEST",
        message: "Audio is required.",
        status: 400,
      });
    if (audioBuffer.byteLength <= 0)
      throw new VoiceLabApiError({
        code: "AUDIO_INVALID",
        message: "The recording is empty.",
        status: 422,
      });
    if (audioBuffer.byteLength > MAX_AUDIO_BYTES)
      throw new VoiceLabApiError({
        code: "AUDIO_LIMIT_EXCEEDED",
        message: "The audio file is larger than 200 MiB.",
        status: 413,
        details: { max_audio_bytes: MAX_AUDIO_BYTES },
      });
    if (this.activeDictationOperations.size >= 1)
      throw new VoiceLabApiError({
        code: "CONCURRENCY_LIMIT",
        message: "Another VoiceLab Flow operation is already running.",
        status: 429,
        details: { max_concurrent_operations: 1 },
      });
    const operationAuthContext = authSessionContext(this.authManager);
    if (!operationAuthContext.sessionId && !operationAuthContext.accountId) {
      throw new VoiceLabApiError({
        code: "AUTH_REQUIRED",
        message: "Authentication required.",
        status: 401,
      });
    }
    const operation = {
      operationId: crypto.randomUUID(),
      source,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      language: normalizedLanguage,
      accountId: operationAuthContext.accountId,
      authContext: operationAuthContext,
      abortController: new AbortController(),
    };
    this.activeDictationOperations.set(operation.operationId, operation);
    try {
      const { entitlement, requestId } = await this.getDesktopUsage();
      if (entitlement.active !== true) {
        throw new VoiceLabApiError({
          code: "ENTITLEMENT_REQUIRED",
          message: "An active VoiceLab desktop plan is required.",
          status: 402,
          details: {
            error: { code: "desktop_subscription_required" },
            request_id: requestId,
          },
        });
      }
      return operation;
    } catch (error) {
      this.activeDictationOperations.delete(operation.operationId);
      throw error;
    }
  }

  async sendDictationChunk(operation, audioBuffer, metadata = {}) {
    const currentAuthContext = authSessionContext(this.authManager);
    const operationStillOwned = operation.authContext
      ? sameAuthSessionContext(operation.authContext, currentAuthContext)
      : Boolean(operation.accountId) && operation.accountId === currentAuthContext.accountId;
    if (!operationStillOwned) {
      throw new VoiceLabApiError({
        code: "AUTH_ACCOUNT_CHANGED",
        message: "This operation belongs to a different VoiceLab account.",
        status: 409,
      });
    }
    const language = metadata.language ?? operation.language;
    if (language && !SUPPORTED_LANGUAGES.has(language)) {
      throw new VoiceLabApiError({
        code: "AUDIO_LANGUAGE_UNSUPPORTED",
        message: "This language is not available for VoiceLab Cloud.",
        status: 422,
      });
    }
    const contentType = String(metadata.contentType || "")
      .trim()
      .toLowerCase();
    const canonicalExtension = CANONICAL_AUDIO_UPLOADS.get(contentType) || "bin";
    const uploadContentType = CANONICAL_AUDIO_UPLOADS.has(contentType)
      ? contentType
      : "application/octet-stream";
    const bodyFactory = () => {
      const form = new FormData();
      form.append(
        "audio",
        new Blob([audioBuffer], { type: uploadContentType }),
        `audio.${canonicalExtension}`
      );
      if (language) form.append("language", language);
      // Meeting segments are metered but never kept in the dictation history.
      if (metadata.purpose === "meeting") form.append("purpose", "meeting");
      return form;
    };
    const result = await this.authenticatedFetch("/v1/desktop/stt", {
      method: "POST",
      bodyFactory,
      timeoutMs: 120_000,
      signals: [operation.abortController?.signal, metadata.signal],
    });
    return normalizeDesktopSttResponse(result);
  }

  _unsupportedDesktopEndpoint() {
    throw new VoiceLabApiError({
      code: "DESKTOP_ENDPOINT_UNAVAILABLE",
      message: "This desktop network feature is not available.",
      status: 501,
    });
  }

  async getSyncBootstrap() {
    return this._unsupportedDesktopEndpoint();
  }

  async pushSyncMutations() {
    return this._unsupportedDesktopEndpoint();
  }

  async getSyncChanges() {
    return this._unsupportedDesktopEndpoint();
  }

  finishDictation(operation) {
    this.activeDictationOperations.delete(operation.operationId);
  }
  failDictation(operation, error) {
    void error;
    this.activeDictationOperations.delete(operation.operationId);
  }

  async publicResult(payload, operationId) {
    const operation = payload?.operation || payload || {};
    const result = operation?.result || payload?.result || operation;
    const usage = result.usage && typeof result.usage === "object" ? result.usage : null;
    return {
      success: true,
      text: result.transcript || result.text || "",
      source: "voicelab",
      operationId,
      language: result.language || null,
      usage,
      usedSeconds: usage?.used_seconds ?? null,
      dailyLimitSeconds: usage?.limit_seconds ?? null,
      remainingSeconds: usage?.remaining_seconds ?? null,
      requestId: result.request_id || null,
      limits: {
        dictation_enabled: true,
        dictation_max_concurrent_operations: 1,
        supported_languages: [...SUPPORTED_LANGUAGES],
        auto_detection_supported: false,
      },
      // This endpoint is a VoiceLab boundary. Do not leak legacy or
      // implementation-specific provider names returned by the server.
      sttProvider: "voicelab",
      sttModel: result.stt_model || result.model || null,
      audioDurationMs:
        result.audio_duration_ms ??
        result.duration_ms ??
        (result.duration_seconds != null
          ? Math.round(Number(result.duration_seconds) * 1000)
          : null),
      desktopTranscriptionId: result.id || null,
      desktopRevision: result.revision ?? null,
      desktopAudioAvailable: result.audio_available === true,
      // This expires quickly and must never be persisted. It is not used by
      // the current recording flow; playback always gets a fresh URL instead.
      audioUrl: result.audio_url || null,
    };
  }
}

module.exports = VoiceLabApiClient;
module.exports.VoiceLabApiError = VoiceLabApiError;
