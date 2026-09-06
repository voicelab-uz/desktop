const crypto = require("crypto");
const { EventEmitter } = require("events");
const http = require("http");
const os = require("os");
const { shell } = require("electron");

const authLogger = require("./authLogger");
const tokenStore = require("./tokenStore");

const CLIENT_ID = "voicelab-desktop";
const PENDING_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const BROWSER_OPEN_TIMEOUT_MS = 10_000;
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACCESS_EXPIRES_IN_SECONDS = 24 * 60 * 60;
const MAX_REFRESH_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_EXPIRY_SKEW_MS = 60_000;
const REFRESH_RETRY_INITIAL_MS = 5_000;
const REFRESH_RETRY_MAX_MS = 5 * 60_000;
const CALLBACK_MAX_LENGTH = 4096;
const CALLBACK_ALLOWED_PARAMS = new Set(["code", "state"]);
const AUTHORIZATION_QUERY_PARAMS = new Set(["desktop_auth_id"]);
const AUTHORIZATION_REQUEST_ID_PATTERN = /^dau_[A-Za-z0-9_-]{1,256}$/;
const AUTHORIZATION_CODE_PATTERN = /^dac_[A-Za-z0-9_-]{1,1020}$/;
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{1,256}$/;
const OAUTH_VALUE_PATTERN = /^[A-Za-z0-9._~-]+$/;
const PKCE_VALUE_LENGTH = 43;
const DEVICE_NAME_MAX_LENGTH = 100;
const APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const USER_ID_MAX_LENGTH = 256;
const USER_EMAIL_MAX_LENGTH = 320;
const USER_NAME_MAX_LENGTH = 256;
const USER_IMAGE_MAX_LENGTH = 2048;

class DesktopAuthError extends Error {
  constructor(code, message, httpStatus = null, details = {}) {
    super(publicErrorMessage(message) || "Authentication request failed");
    this.name = "DesktopAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = details.requestId || null;
    this.fields = details.fields || null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

function positiveIntegerSeconds(value, field, maximum, requestId = null) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DesktopAuthError(
      "AUTH_TOKEN_RESPONSE_INVALID",
      `Authentication token response has invalid ${field}`,
      null,
      { requestId }
    );
  }
  return value;
}

async function boundedResponseText(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new DesktopAuthError(
      "AUTH_BACKEND_RESPONSE_INVALID",
      "Authentication server response is too large",
      response.status
    );
  }
  if (!response.body) return typeof response.text === "function" ? response.text() : "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DesktopAuthError(
          "AUTH_BACKEND_RESPONSE_INVALID",
          "Authentication server response is too large",
          response.status
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
}

function boundedToken(value) {
  return typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 8192 &&
    !/\s/.test(value)
    ? value
    : null;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicErrorMessage(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 500) || null
    : null;
}

function publicRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function publicErrorFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).slice(0, 32);
  const fields = {};
  for (const [key, message] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    const normalized = publicErrorMessage(message);
    if (normalized) fields[key] = normalized;
  }
  return Object.keys(fields).length ? fields : null;
}

function retryAfterSeconds(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 3600);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)), 3600);
}

function sanitizedDeviceName(value = os.hostname()) {
  const sanitized = String(value || "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DEVICE_NAME_MAX_LENGTH);
  return sanitized || `VoiceLab Desktop (${process.platform})`;
}

function desktopPlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new DesktopAuthError("AUTH_PLATFORM_UNSUPPORTED", "Desktop platform is unsupported");
}

function boundedIdentity(value, maxLength) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, "")
    .trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function boundedDisplayName(value, fallback) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USER_NAME_MAX_LENGTH);
  return normalized || fallback;
}

function safeUserImage(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > USER_IMAGE_MAX_LENGTH) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function canonicalUser(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawId = value.id ?? value.user_id ?? value.uuid ?? value.sub;
  const rawEmail = value.email ?? value.username ?? value.preferred_username;
  const id = boundedIdentity(rawId, USER_ID_MAX_LENGTH);
  const email = boundedIdentity(rawEmail, USER_EMAIL_MAX_LENGTH);
  if (!id || !email) return null;
  const givenName = value.given_name ?? value.first_name;
  const familyName = value.family_name ?? value.last_name;
  const combinedName =
    typeof givenName === "string" && typeof familyName === "string"
      ? `${givenName} ${familyName}`
      : null;
  const rawName =
    value.full_name ?? combinedName ?? value.name ?? value.display_name ?? value.username ?? email;
  const rawImage = value.image ?? value.avatar ?? value.avatar_url ?? value.picture;
  return {
    id,
    email,
    name: boundedDisplayName(rawName, email),
    image: safeUserImage(rawImage),
  };
}

function userFromAccessToken(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    !segments[1] ||
    segments[1].length > 22_000 ||
    !/^[A-Za-z0-9_-]+$/.test(segments[1])
  ) {
    return null;
  }
  try {
    const payload = Buffer.from(segments[1], "base64url");
    if (!payload.length || payload.length > 16 * 1024) return null;
    return canonicalUser(JSON.parse(payload.toString("utf8")));
  } catch {
    return null;
  }
}

function normalizedUser(payload) {
  const candidates = [
    payload?.user,
    payload?.result?.user,
    payload?.profile?.user,
    payload?.result?.profile?.user,
    payload?.profile,
    payload?.result,
    payload,
  ];
  for (const candidate of candidates) {
    const user = canonicalUser(candidate);
    if (user) return user;
  }
  return null;
}

class DesktopAuthManager extends EventEmitter {
  constructor({
    channel,
    scheme,
    appVersion,
    apiBaseUrl,
    authWebBaseUrl,
    authorizationOrigins,
    useCustomProtocol = false,
  }) {
    super();
    if (!channel || !scheme || !appVersion || !apiBaseUrl || !authorizationOrigins?.length) {
      throw new Error("Desktop authentication runtime configuration is incomplete");
    }
    if (!APP_VERSION_PATTERN.test(String(appVersion))) {
      throw new Error("Desktop application version is invalid");
    }
    this.channel = channel;
    this.scheme = scheme;
    this.appVersion = appVersion;
    this.apiBaseUrl = this._validateOrigin(apiBaseUrl, "Desktop API origin");
    this.authorizationOrigins = new Set(
      authorizationOrigins.map((origin) => this._validateOrigin(origin, "Authorization origin"))
    );
    this.authOrigin = this._validateOrigin(
      authWebBaseUrl || authorizationOrigins[0],
      "Authorization web origin"
    );
    if (!this.authorizationOrigins.has(this.authOrigin)) {
      throw new Error("Desktop authorization web origin is not trusted");
    }
    // Prefer the OS-owned callback whenever VoiceLab registered its protocol.
    // PKCE keeps the one-time code bound to this exact desktop installation.
    this.useCustomProtocol = useCustomProtocol === true;
    this.status = "signed-out";
    this.user = null;
    this.errorCode = null;
    this.errorMessage = null;
    this.errorRequestId = null;
    this.errorFields = null;
    this.retryAfterSeconds = null;
    this.pendingExpiryTimer = null;
    this.callbackServer = null;
    this.callbackRedirectUri = null;
    this.refreshPromise = null;
    this.refreshPromiseEpoch = null;
    this.authorizationPromise = null;
    this.authorizationPromiseEpoch = null;
    this.accessRefreshTimer = null;
    this.refreshRetryTimer = null;
    this.refreshRetryAttempt = 0;
    this.bootstrapPromise = null;
    this.authEpoch = 0;
    this._suspended = false;
  }

  // Called right before the app quits to install an update. Refresh tokens
  // are single-use, so a proactive or retry timer that fires during the quit
  // sequence and starts its own exchange is racing whatever the relaunched
  // app does on its own first launch. Neither side can tell it's losing until
  // the server rejects it, so it's simpler to just not start one here.
  suspendBackgroundRefresh() {
    this._suspended = true;
    this._clearAccessRefreshTimer();
    this._clearRefreshRetryTimer();
  }

  _advanceAuthEpoch() {
    this.authEpoch += 1;
    this._clearAccessRefreshTimer();
    this._clearRefreshRetryTimer();
    this.refreshPromise = null;
    this.refreshPromiseEpoch = null;
    return this.authEpoch;
  }

  _clearAccessRefreshTimer() {
    clearTimeout(this.accessRefreshTimer);
    this.accessRefreshTimer = null;
  }

  _clearRefreshRetryTimer() {
    clearTimeout(this.refreshRetryTimer);
    this.refreshRetryTimer = null;
    this.refreshRetryAttempt = 0;
  }

  _scheduleRefreshRetry(retryAfterSeconds = null) {
    if (this._suspended || this.refreshRetryTimer || !tokenStore.getSession()?.refreshToken) {
      return;
    }
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(1_000, Math.min(retryAfterSeconds * 1000, REFRESH_RETRY_MAX_MS))
      : null;
    const backoffMs = Math.min(
      REFRESH_RETRY_INITIAL_MS * 2 ** this.refreshRetryAttempt,
      REFRESH_RETRY_MAX_MS
    );
    const delayMs = retryAfterMs ?? backoffMs;
    this.refreshRetryAttempt = Math.min(this.refreshRetryAttempt + 1, 16);
    this.refreshRetryTimer = setTimeout(() => {
      this.refreshRetryTimer = null;
      void this.refreshSession({ force: true }).catch((error) => {
        authLogger.warn("background_refresh_retry_failed", {
          errorCode: error.code || "AUTH_REFRESH_FAILED",
          httpStatus: error.httpStatus,
          requestId: error.requestId,
        });
      });
    }, delayMs);
    this.refreshRetryTimer.unref?.();
  }

  _preserveSessionAfterRefreshFailure(error, session = tokenStore.getSession()) {
    const user = canonicalUser(session?.user);
    const details = {
      user,
      errorCode: error?.code || "AUTH_REFRESH_FAILED",
      errorMessage: error?.message,
      errorRequestId: error?.requestId,
      errorFields: error?.fields,
      retryAfterSeconds: error?.retryAfterSeconds,
    };
    // A saved profile means the app can remain usable while a new access token
    // is fetched in the background. Only the person signing out may erase it.
    this._setStatus(user ? "authenticated" : "error", details);
    this._scheduleRefreshRetry(error?.retryAfterSeconds);
  }

  _scheduleAccessTokenRefresh(session = tokenStore.getSession()) {
    this._clearAccessRefreshTimer();
    if (
      this._suspended ||
      !session?.refreshToken ||
      !Number.isFinite(session.accessExpiresAt) ||
      session.accessExpiresAt <= 0
    ) {
      return;
    }
    const delayMs = Math.max(
      1_000,
      session.accessExpiresAt - Date.now() - ACCESS_EXPIRY_SKEW_MS
    );
    this.accessRefreshTimer = setTimeout(() => {
      this.accessRefreshTimer = null;
      void this.refreshSession({ force: true }).catch((error) => {
        authLogger.warn("proactive_refresh_failed", {
          errorCode: error.code || "AUTH_REFRESH_FAILED",
          httpStatus: error.httpStatus,
          requestId: error.requestId,
        });
      });
    }, delayMs);
    this.accessRefreshTimer.unref?.();
  }

  _assertAuthEpoch(epoch) {
    if (epoch !== this.authEpoch) {
      throw new DesktopAuthError(
        "AUTH_OPERATION_SUPERSEDED",
        "Authentication operation was superseded"
      );
    }
  }

  async _openAuthorizationUrl(authorizationUrl) {
    let timeout = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => shell.openExternal(authorizationUrl, { activate: true })),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new DesktopAuthError(
                "AUTH_BROWSER_OPEN_TIMEOUT",
                "Could not open your browser. Please try again."
              )
            );
          }, BROWSER_OPEN_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  _validateOrigin(value, label) {
    try {
      const url = new URL(String(value));
      const localDevelopment =
        this.channel === "development" &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname);
      if (
        (!localDevelopment && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.origin !== String(value).replace(/\/+$/, "") ||
        (url.pathname && url.pathname !== "/") ||
        url.search ||
        url.hash
      ) {
        throw new Error("invalid origin");
      }
      return url.origin;
    } catch {
      throw new Error(`${label} is invalid`);
    }
  }

  async initialize() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = this._bootstrap().finally(() => {
      this.bootstrapPromise = null;
    });
    return this.bootstrapPromise;
  }

  async _bootstrap() {
    const epoch = this.authEpoch;
    let pending = tokenStore.getPending();
    // A loopback callback is bound to the process that created it. It cannot be
    // resumed safely after a restart, so discard it and create a fresh request.
    if (pending && this._isLoopbackRedirectUri(pending.redirectUri)) {
      tokenStore.clearPending();
      pending = null;
    }
    if (pending && !this._isValidPending(pending)) {
      tokenStore.clearPending();
      pending = null;
    }
    if (pending) this._schedulePendingExpiry(pending.expiresAt);

    const storedSession = tokenStore.getSession();
    if (!storedSession) {
      this._setStatus(pending ? "waiting-for-browser" : "signed-out");
      return this.getPublicStatus();
    }

    const storedUser = canonicalUser(storedSession.user);
    // Do not send a returning user back to the account gate while the access
    // token is being refreshed after a launch or an app update.
    this._setStatus(storedUser ? "authenticated" : "checking-session", { user: storedUser });
    try {
      // Access credentials are process-memory only. Every launch rotates the
      // persisted refresh credential before the desktop session is usable.
      await this.refreshSession({ force: true });
      this._assertAuthEpoch(epoch);
      const current = tokenStore.getSession();
      if (!current?.accessToken) throw new DesktopAuthError("AUTH_EXPIRED", "Session expired");
      const user = canonicalUser(current.user);
      this._assertAuthEpoch(epoch);
      this._setStatus("authenticated", { user });
    } catch (error) {
      if (epoch !== this.authEpoch || error?.code === "AUTH_OPERATION_SUPERSEDED") {
        return this.getPublicStatus();
      }
      const retainedSession = tokenStore.getSession();
      if (retainedSession?.refreshToken) {
        this._preserveSessionAfterRefreshFailure(error, retainedSession);
      } else {
        this._setStatus(pending ? "waiting-for-browser" : "signed-out", {
          errorCode: error.code || "AUTH_SESSION_INVALID",
          errorMessage: error.message,
          errorRequestId: error.requestId,
          errorFields: error.fields,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      authLogger.warn("bootstrap_failed", {
        errorCode: error.code || "AUTH_SESSION_INVALID",
        httpStatus: error.httpStatus,
        requestId: error.requestId,
      });
    }
    return this.getPublicStatus();
  }

  getPublicStatus() {
    const status = {
      status: this.status,
      user: this.user,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
    };
    if (this.errorRequestId) status.errorRequestId = this.errorRequestId;
    if (this.errorFields) status.errorFields = this.errorFields;
    if (this.retryAfterSeconds != null) status.retryAfterSeconds = this.retryAfterSeconds;
    return status;
  }

  getSessionMetadata() {
    const storedSession = tokenStore.getSession();
    return {
      sessionId: storedSession?.sessionId || null,
      accountId: storedSession?.user
        ? String(storedSession.user.id ?? storedSession.user.user_id ?? storedSession.user.uuid)
        : storedSession?.sessionId || null,
      installationId: tokenStore.getInstallationId(),
      channel: this.channel,
    };
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    const suppliedUser = extra.user === undefined ? this.user : extra.user;
    this.user = status === "authenticated" ? canonicalUser(suppliedUser) : null;
    this.errorCode = extra.errorCode || null;
    this.errorMessage = publicErrorMessage(extra.errorMessage);
    this.errorRequestId = publicRequestId(extra.errorRequestId);
    this.errorFields = publicErrorFields(extra.errorFields);
    this.retryAfterSeconds = Number.isFinite(extra.retryAfterSeconds)
      ? extra.retryAfterSeconds
      : null;
    if (status === "authenticated") this._scheduleAccessTokenRefresh();
    else this._clearAccessRefreshTimer();
    this.emit("status", this.getPublicStatus());
  }

  _isValidPending(pending) {
    const now = Date.now();
    const fieldsAreValid = Boolean(
      pending &&
      typeof pending === "object" &&
      typeof pending.codeVerifier === "string" &&
      pending.codeVerifier.length === PKCE_VALUE_LENGTH &&
      OAUTH_VALUE_PATTERN.test(pending.codeVerifier) &&
      typeof pending.state === "string" &&
      pending.state.length === PKCE_VALUE_LENGTH &&
      OAUTH_VALUE_PATTERN.test(pending.state) &&
      this._isAllowedRedirectUri(pending.redirectUri) &&
      AUTHORIZATION_REQUEST_ID_PATTERN.test(pending.authorizationRequestId || "") &&
      typeof pending.authorizationUrl === "string" &&
      pending.authorizationUrl.length <= CALLBACK_MAX_LENGTH &&
      Number.isFinite(pending.createdAt) &&
      Number.isFinite(pending.expiresAt) &&
      pending.createdAt <= now + 30_000 &&
      pending.expiresAt > now &&
      pending.expiresAt - pending.createdAt <= PENDING_TTL_MS
    );
    if (!fieldsAreValid) return false;
    try {
      this._validateAuthorizationUrl(pending.authorizationUrl, pending.authorizationRequestId);
      return true;
    } catch {
      return false;
    }
  }

  _isLoopbackRedirectUri(value) {
    try {
      const url = new URL(String(value));
      const port = Number(url.port);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        Number.isInteger(port) &&
        port >= 1024 &&
        port <= 65535 &&
        url.pathname === "/callback" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }

  _isAllowedRedirectUri(value) {
    return value === `${this.scheme}://auth/callback` || this._isLoopbackRedirectUri(value);
  }

  _closeLoopbackCallbackServer() {
    const server = this.callbackServer;
    this.callbackServer = null;
    this.callbackRedirectUri = null;
    if (server) {
      try {
        server.close();
      } catch {}
    }
  }

  async _startLoopbackCallbackServer() {
    this._closeLoopbackCallbackServer();
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this._handleLoopbackCallback(request, response);
      });
      const fail = (error) => {
        if (this.callbackServer === server) this._closeLoopbackCallbackServer();
        reject(
          new DesktopAuthError(
            "AUTH_CALLBACK_SERVER_FAILED",
            error?.message || "Authentication callback server failed"
          )
        );
      };
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", fail);
        const address = server.address();
        const port = address && typeof address === "object" ? Number(address.port) : 0;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          server.close();
          reject(
            new DesktopAuthError(
              "AUTH_CALLBACK_SERVER_FAILED",
              "Authentication callback server selected an invalid port"
            )
          );
          return;
        }
        this.callbackServer = server;
        this.callbackRedirectUri = `http://127.0.0.1:${port}/callback`;
        server.unref?.();
        resolve(this.callbackRedirectUri);
      });
    });
  }

  async _createAuthorizationRedirectUri() {
    if (this.useCustomProtocol) {
      this._closeLoopbackCallbackServer();
      return `${this.scheme}://auth/callback`;
    }
    return this._startLoopbackCallbackServer();
  }

  _writeLoopbackResponse(response, statusCode, title, message) {
    const safeTitle = String(title).replace(/[<>&"']/g, "");
    const safeMessage = String(message).replace(/[<>&"']/g, "");
    const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{margin:0;background:#f7f7f5;color:#171717;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:440px;margin:24px;padding:32px;border:1px solid #ddd;border-radius:20px;background:#fff}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;margin:0;color:#666}</style></head><body><main class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`;
    response.writeHead(statusCode, {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  async _handleLoopbackCallback(request, response) {
    const redirectUri = this.callbackRedirectUri;
    if (!redirectUri || request.method !== "GET" || request.socket?.remoteAddress !== "127.0.0.1") {
      this._writeLoopbackResponse(
        response,
        400,
        "VoiceLab sign-in failed",
        "Invalid callback request."
      );
      return;
    }
    let callbackUrl;
    try {
      callbackUrl = new URL(request.url || "", redirectUri);
      if (
        callbackUrl.origin !== new URL(redirectUri).origin ||
        callbackUrl.pathname !== "/callback"
      ) {
        throw new Error("invalid callback route");
      }
      // Stop accepting callback connections before parsing state or exchanging
      // the code. The loopback redirect is intentionally single-use.
      this._closeLoopbackCallbackServer();
      const result = await this.handleCallback(callbackUrl.toString());
      if (result.status !== "authenticated") {
        this._writeLoopbackResponse(
          response,
          409,
          "VoiceLab sign-in not completed",
          "Return to VoiceLab Desktop and try again."
        );
        return;
      }
      this._writeLoopbackResponse(
        response,
        200,
        "VoiceLab sign-in complete",
        "You can close this tab and continue in VoiceLab Desktop."
      );
    } catch (error) {
      authLogger.warn("loopback_callback_failed", {
        errorCode: error?.code || "AUTH_CALLBACK_ERROR",
        httpStatus: error?.httpStatus,
        requestId: error?.requestId,
      });
      this._writeLoopbackResponse(
        response,
        400,
        "VoiceLab sign-in failed",
        "Return to VoiceLab Desktop and start sign-in again."
      );
    }
  }

  _schedulePendingExpiry(expiresAt, epoch = this.authEpoch) {
    clearTimeout(this.pendingExpiryTimer);
    const delay = Math.max(0, expiresAt - Date.now());
    this.pendingExpiryTimer = setTimeout(() => {
      if (epoch !== this.authEpoch) return;
      this._closeLoopbackCallbackServer();
      tokenStore.clearPending();
      this._setStatus("expired", { errorCode: "AUTH_TRANSACTION_EXPIRED" });
    }, delay);
    this.pendingExpiryTimer.unref?.();
  }

  async _request(pathname, init = {}, policy = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.apiBaseUrl}${pathname}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {}),
        },
        signal: controller.signal,
      });
      const text = await boundedResponseText(response);
      if (text && !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) {
        throw new DesktopAuthError(
          "AUTH_BACKEND_RESPONSE_INVALID",
          "Authentication server returned an invalid response",
          response.status
        );
      }
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new DesktopAuthError(
            "AUTH_BACKEND_RESPONSE_INVALID",
            "Authentication server returned an invalid response",
            response.status
          );
        }
      }
      if (!response.ok) {
        const envelope = body?.error && typeof body.error === "object" ? body.error : null;
        const requestId = publicRequestId(body?.request_id);
        throw new DesktopAuthError(
          envelope?.code ||
            body?.code ||
            (response.status === 401 ? "AUTH_UNAUTHORIZED" : "AUTH_BACKEND_REJECTED"),
          body?.message ||
            envelope?.message ||
            (typeof body?.error === "string" ? body.error : null) ||
            body?.detail ||
            "Authentication request failed",
          response.status,
          {
            requestId,
            fields: publicErrorFields(envelope?.fields),
            retryAfterSeconds: retryAfterSeconds(response.headers.get("Retry-After")),
          }
        );
      }
      if (policy.expectedStatus != null && response.status !== policy.expectedStatus) {
        throw new DesktopAuthError(
          "AUTH_BACKEND_RESPONSE_INVALID",
          "Authentication server returned an unexpected status",
          response.status
        );
      }
      if (policy.body === "json" && (!text || !body || typeof body !== "object")) {
        throw new DesktopAuthError(
          "AUTH_BACKEND_RESPONSE_INVALID",
          "Authentication server returned an invalid response",
          response.status
        );
      }
      if (policy.body === "empty" && text) {
        throw new DesktopAuthError(
          "AUTH_BACKEND_RESPONSE_INVALID",
          "Authentication server returned an unexpected response body",
          response.status
        );
      }
      return body;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new DesktopAuthError("AUTH_NETWORK_TIMEOUT", "Authentication request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  _validateAuthorizationUrl(value, expectedRequestId) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new DesktopAuthError("AUTHORIZATION_URL_INVALID", "Authorization URL is invalid");
    }
    const loopbackDevelopment =
      this.channel === "development" &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname);
    if (
      (!this.authorizationOrigins.has(url.origin) && !loopbackDevelopment) ||
      url.origin !== this.authOrigin
    ) {
      throw new DesktopAuthError("AUTHORIZATION_ORIGIN_REJECTED", "Authorization origin rejected");
    }
    if (
      url.pathname !== "/app/sign-in" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.searchParams.get("desktop_auth_id") !== expectedRequestId
    ) {
      throw new DesktopAuthError("AUTHORIZATION_URL_INVALID", "Authorization URL is invalid");
    }
    const queryKeys = [...url.searchParams.keys()];
    if (
      queryKeys.length !== AUTHORIZATION_QUERY_PARAMS.size ||
      queryKeys.some(
        (key) => !AUTHORIZATION_QUERY_PARAMS.has(key) || url.searchParams.getAll(key).length !== 1
      )
    ) {
      throw new DesktopAuthError("AUTHORIZATION_URL_INVALID", "Authorization URL is invalid");
    }
    return value;
  }

  startAuthorization() {
    // More than one renderer action can arrive while an authorization request
    // is being created. Share that real in-flight operation; returning a
    // synthetic "opening-browser" status here used to leave the renderer
    // spinning forever without ever calling shell.openExternal.
    if (
      this.authorizationPromise &&
      this.authorizationPromiseEpoch === this.authEpoch
    ) {
      return this.authorizationPromise;
    }

    const attempt = this._startAuthorization();
    const trackedAttempt = attempt.finally(() => {
      if (this.authorizationPromise === trackedAttempt) {
        this.authorizationPromise = null;
        this.authorizationPromiseEpoch = null;
      }
    });
    this.authorizationPromise = trackedAttempt;
    this.authorizationPromiseEpoch = this.authEpoch;
    return trackedAttempt;
  }

  async _startAuthorization() {
    if (this.status === "exchanging") return this.getPublicStatus();
    const existingPending = tokenStore.getPending();
    if (existingPending && this._isValidPending(existingPending)) {
      return this.reopenAuthorization();
    }
    tokenStore.clearPending();
    clearTimeout(this.pendingExpiryTimer);
    const epoch = this._advanceAuthEpoch();

    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(32));
    this._setStatus("opening-browser");

    let operationRedirectUri = null;
    try {
      const redirectUri = await this._createAuthorizationRedirectUri();
      operationRedirectUri = redirectUri;
      this._assertAuthEpoch(epoch);
      const pending = {
        codeVerifier,
        state,
        redirectUri,
        createdAt: Date.now(),
        expiresAt: Date.now() + PENDING_TTL_MS,
      };
      tokenStore.savePending(pending);
      const response = await this._request("/api/v2/auth/desktop/authorizations", {
        method: "POST",
        headers: { "X-Request-ID": crypto.randomUUID() },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          installation_id: tokenStore.getInstallationId(),
          device_name: sanitizedDeviceName(),
          app_version: this.appVersion,
          platform: desktopPlatform(),
        }),
      }, { expectedStatus: 201, body: "json" });
      this._assertAuthEpoch(epoch);
      const requestId = response?.authorization_request_id;
      if (
        typeof requestId !== "string" ||
        !AUTHORIZATION_REQUEST_ID_PATTERN.test(requestId) ||
        typeof response?.authorization_url !== "string" ||
        !publicRequestId(response?.request_id) ||
        !Number.isSafeInteger(response?.expires_in) ||
        response.expires_in <= 0 ||
        response.expires_in > PENDING_TTL_MS / 1000
      ) {
        throw new DesktopAuthError(
          "AUTHORIZATION_RESPONSE_INVALID",
          "Authorization response invalid",
          null,
          { requestId: publicRequestId(response?.request_id) }
        );
      }
      const authorizationUrl = this._validateAuthorizationUrl(
        response.authorization_url,
        requestId
      );
      const expiresAt = Math.min(pending.expiresAt, Date.now() + response.expires_in * 1000);
      tokenStore.savePending({
        ...pending,
        authorizationRequestId: requestId,
        authorizationUrl,
        expiresAt,
      });
      this._schedulePendingExpiry(expiresAt);
      await this._openAuthorizationUrl(authorizationUrl);
      this._assertAuthEpoch(epoch);
      this._setStatus("waiting-for-browser");
      return this.getPublicStatus();
    } catch (error) {
      if (epoch !== this.authEpoch || error?.code === "AUTH_OPERATION_SUPERSEDED") {
        if (this.callbackRedirectUri === operationRedirectUri) this._closeLoopbackCallbackServer();
        return this.getPublicStatus();
      }
      this._closeLoopbackCallbackServer();
      tokenStore.clearPending();
      clearTimeout(this.pendingExpiryTimer);
      this._setStatus("error", {
        errorCode: error.code || "AUTH_START_FAILED",
        errorMessage: error.message,
        errorRequestId: error.requestId,
        errorFields: error.fields,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      throw error;
    }
  }

  async reopenAuthorization() {
    const pending = tokenStore.getPending();
    if (!pending || !this._isValidPending(pending)) {
      tokenStore.clearPending();
      clearTimeout(this.pendingExpiryTimer);
      const expired = pending && Number(pending.expiresAt) <= Date.now();
      this._setStatus(expired ? "expired" : "signed-out", {
        errorCode: expired ? "AUTH_TRANSACTION_EXPIRED" : null,
      });
      return this.getPublicStatus();
    }

    const authorizationUrl = this._validateAuthorizationUrl(
      pending.authorizationUrl,
      pending.authorizationRequestId
    );
    this._setStatus("opening-browser");
    try {
      await this._openAuthorizationUrl(authorizationUrl);
      this._setStatus("waiting-for-browser");
      return this.getPublicStatus();
    } catch (error) {
      // Keep a still-valid authorization request so the person can use
      // "Open browser" again, but never leave the UI in an endless loader.
      this._setStatus("error", {
        errorCode: error.code || "AUTH_BROWSER_OPEN_FAILED",
        errorMessage: error.message,
        errorRequestId: error.requestId,
        errorFields: error.fields,
      });
      throw error;
    }
  }

  cancelAuthorization() {
    this._advanceAuthEpoch();
    this._closeLoopbackCallbackServer();
    tokenStore.clearPending();
    clearTimeout(this.pendingExpiryTimer);
    this._setStatus("cancelled", { errorCode: "AUTH_CANCELLED_BY_USER" });
    return this.getPublicStatus();
  }

  _parseCallback(value, expectedRedirectUri = `${this.scheme}://auth/callback`) {
    if (typeof value !== "string" || value.length > CALLBACK_MAX_LENGTH) {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    let expected;
    try {
      expected = new URL(expectedRedirectUri);
    } catch {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    if (
      !this._isAllowedRedirectUri(expected.toString()) ||
      url.protocol !== expected.protocol ||
      url.hostname !== expected.hostname ||
      url.port !== expected.port ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    for (const key of url.searchParams.keys()) {
      if (!CALLBACK_ALLOWED_PARAMS.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
      }
    }
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (state.length < 32 || state.length > 256 || !OAUTH_VALUE_PATTERN.test(state)) {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    if (!AUTHORIZATION_CODE_PATTERN.test(code)) {
      throw new DesktopAuthError("AUTH_CALLBACK_INVALID", "Authentication callback is invalid");
    }
    return { state, code };
  }

  async handleCallback(callbackUrl) {
    const pending = tokenStore.getPending();
    if (!pending) {
      const storedSession = tokenStore.getSession();
      const user = canonicalUser(storedSession?.user);
      if (storedSession?.kind === "desktop-go-v2" && storedSession.accessToken) {
        this._setStatus("authenticated", { user });
        return this.getPublicStatus();
      }
      throw new DesktopAuthError("AUTH_TRANSACTION_MISSING", "No pending authentication request");
    }
    const epoch = this.authEpoch;
    try {
      if (!this._isValidPending(pending)) {
        this._closeLoopbackCallbackServer();
        tokenStore.clearPending();
        clearTimeout(this.pendingExpiryTimer);
        if (Number(pending.expiresAt) <= Date.now()) {
          this._setStatus("expired", { errorCode: "AUTH_TRANSACTION_EXPIRED" });
          return this.getPublicStatus();
        }
        throw new DesktopAuthError("AUTH_TRANSACTION_INVALID", "Authentication request is invalid");
      }
      if (pending.callbackFingerprint) {
        if (this.status === "exchanging") return this.getPublicStatus();
        throw new DesktopAuthError(
          "AUTH_CALLBACK_REPLAYED",
          "Authentication callback was already used"
        );
      }
      const callback = this._parseCallback(callbackUrl, pending.redirectUri);
      if (!constantTimeEqual(callback.state, pending.state)) {
        throw new DesktopAuthError("AUTH_STATE_MISMATCH", "Authentication state mismatch");
      }
      const fingerprint = base64url(
        crypto.createHash("sha256").update(`${callback.code}\0${callback.state}`).digest()
      );
      tokenStore.savePending({ ...pending, callbackFingerprint: fingerprint });
      clearTimeout(this.pendingExpiryTimer);
      this._setStatus("exchanging");

      const response = await this._request("/api/v2/auth/desktop/token", {
        method: "POST",
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: pending.redirectUri,
          code: callback.code,
          code_verifier: pending.codeVerifier,
          installation_id: tokenStore.getInstallationId(),
        }),
      }, { expectedStatus: 200, body: "json" });
      this._assertAuthEpoch(epoch);
      const user = normalizedUser(response);
      if (!user) {
        throw new DesktopAuthError("AUTH_USER_RESPONSE_INVALID", "Authenticated user is missing");
      }
      this._assertAuthEpoch(epoch);
      const sessionValue = this._sessionFromTokenResponse(response, null, user);
      tokenStore.completeAuthorization(sessionValue);
      clearTimeout(this.pendingExpiryTimer);
      this._closeLoopbackCallbackServer();
      this._setStatus("authenticated", { user });
      return this.getPublicStatus();
    } catch (error) {
      if (epoch !== this.authEpoch || error?.code === "AUTH_OPERATION_SUPERSEDED") {
        return this.getPublicStatus();
      }
      const retryableExchange =
        [429, 503].includes(Number(error?.httpStatus)) && this._isValidPending(pending);
      if (retryableExchange) {
        tokenStore.savePending({ ...pending, callbackFingerprint: "" });
        this._schedulePendingExpiry(pending.expiresAt, epoch);
        this._setStatus("waiting-for-browser", {
          errorCode: error.code || "AUTH_EXCHANGE_FAILED",
          errorMessage: error.message,
          errorRequestId: error.requestId,
          errorFields: error.fields,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        throw error;
      }
      this._closeLoopbackCallbackServer();
      tokenStore.clearPending();
      clearTimeout(this.pendingExpiryTimer);
      this._setStatus("error", {
        errorCode: error.code || "AUTH_EXCHANGE_FAILED",
        errorMessage: error.message,
        errorRequestId: error.requestId,
        errorFields: error.fields,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      authLogger.warn("callback_failed", {
        errorCode: error.code || "AUTH_EXCHANGE_FAILED",
        httpStatus: error.httpStatus,
        requestId: error.requestId,
      });
      throw error;
    }
  }

  _sessionFromTokenResponse(response, existingSession = null, suppliedUser = null) {
    const responseRequestId = publicRequestId(response?.request_id);
    const accessToken = boundedToken(response?.access_token);
    const refreshToken = boundedToken(response?.refresh_token);
    if (
      !accessToken ||
      !refreshToken ||
      response?.token_type !== "Bearer" ||
      !publicRequestId(response?.request_id)
    ) {
      throw new DesktopAuthError(
        "AUTH_TOKEN_RESPONSE_INVALID",
        "Authentication token response invalid",
        null,
        { requestId: responseRequestId }
      );
    }
    if (
      existingSession?.refreshToken &&
      constantTimeEqual(refreshToken, existingSession.refreshToken)
    ) {
      throw new DesktopAuthError(
        "AUTH_REFRESH_ROTATION_REQUIRED",
        "Authentication refresh token was not rotated",
        null,
        { requestId: responseRequestId }
      );
    }
    const user =
      canonicalUser(suppliedUser) ||
      normalizedUser(response) ||
      canonicalUser(existingSession?.user) ||
      userFromAccessToken(accessToken);
    if (!user && !existingSession) {
      throw new DesktopAuthError("AUTH_USER_RESPONSE_INVALID", "Authenticated user is missing", null, {
        requestId: responseRequestId,
      });
    }
    const now = Date.now();
    const accessExpiresIn = positiveIntegerSeconds(
      response.expires_in,
      "expires_in",
      MAX_ACCESS_EXPIRES_IN_SECONDS,
      responseRequestId
    );
    const refreshExpiresIn = positiveIntegerSeconds(
      response.refresh_expires_in,
      "refresh_expires_in",
      MAX_REFRESH_EXPIRES_IN_SECONDS,
      responseRequestId
    );
    const sessionId = response.session_id;
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 512) {
      throw new DesktopAuthError(
        "AUTH_TOKEN_RESPONSE_INVALID",
        "Authentication token response has invalid session_id",
        null,
        { requestId: responseRequestId }
      );
    }
    return {
      kind: "desktop-go-v2",
      accessToken,
      accessExpiresAt: now + accessExpiresIn * 1000,
      refreshToken,
      refreshExpiresAt: now + refreshExpiresIn * 1000,
      sessionId,
      user,
    };
  }

  async refreshSession({ force = false } = {}) {
    const epoch = this.authEpoch;
    if (this.refreshPromise && this.refreshPromiseEpoch === epoch) return this.refreshPromise;
    const operation = this._refreshSession({ force, epoch });
    const tracked = operation.finally(() => {
      if (this.refreshPromise === tracked) {
        this.refreshPromise = null;
        this.refreshPromiseEpoch = null;
      }
    });
    this.refreshPromise = tracked;
    this.refreshPromiseEpoch = epoch;
    return tracked;
  }

  async _refreshSession({ force, epoch }) {
    const storedSession = tokenStore.getSession();
    if (!storedSession?.refreshToken || storedSession.kind !== "desktop-go-v2") {
      const error = new DesktopAuthError("AUTH_EXPIRED", "Session expired");
      this._setStatus("signed-out", {
        errorCode: error.code,
        errorMessage: error.message,
      });
      throw error;
    }
    if (
      !force &&
      storedSession.accessToken &&
      storedSession.accessExpiresAt > Date.now() + ACCESS_EXPIRY_SKEW_MS
    ) {
      return this.getPublicStatus();
    }
    if (storedSession.refreshExpiresAt && storedSession.refreshExpiresAt <= Date.now()) {
      const error = new DesktopAuthError("AUTH_EXPIRED", "Session expired");
      this._preserveSessionAfterRefreshFailure(error, storedSession);
      throw error;
    }
    try {
      const response = await this._request("/api/v2/auth/desktop/token", {
        method: "POST",
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: storedSession.refreshToken,
          installation_id: tokenStore.getInstallationId(),
        }),
      }, { expectedStatus: 200, body: "json" });
      this._assertAuthEpoch(epoch);
      const user = canonicalUser(storedSession.user);
      this._assertAuthEpoch(epoch);
      const updated = this._sessionFromTokenResponse(response, storedSession, user);
      // Persist a successful rotation before treating a missing display profile
      // as recoverable. Otherwise a valid one-time refresh token is lost.
      tokenStore.saveSession(updated);
      if (!canonicalUser(updated.user)) {
        throw new DesktopAuthError(
          "AUTH_PROFILE_REQUIRED",
          "Account profile must be restored by signing in again",
          null,
          { requestId: publicRequestId(response?.request_id) }
        );
      }
      this._clearRefreshRetryTimer();
      this._setStatus("authenticated", { user: updated.user });
      return this.getPublicStatus();
    } catch (error) {
      if (epoch !== this.authEpoch || error?.code === "AUTH_OPERATION_SUPERSEDED") {
        throw new DesktopAuthError(
          "AUTH_OPERATION_SUPERSEDED",
          "Authentication operation was superseded"
        );
      }
      this._preserveSessionAfterRefreshFailure(error, tokenStore.getSession() || storedSession);
      throw error;
    }
  }

  async getValidAccessToken() {
    if (this.bootstrapPromise) await this.bootstrapPromise;
    let storedSession = tokenStore.getSession();
    if (!storedSession) {
      const error = new DesktopAuthError("AUTH_REQUIRED", "Authentication required");
      this._setStatus("signed-out", {
        errorCode: error.code,
        errorMessage: error.message,
      });
      throw error;
    }
    if (
      !storedSession.accessToken ||
      storedSession.accessExpiresAt <= Date.now() + ACCESS_EXPIRY_SKEW_MS
    ) {
      await this.refreshSession({ force: true });
      storedSession = tokenStore.getSession();
    }
    if (!storedSession?.accessToken) {
      throw new DesktopAuthError("AUTH_EXPIRED", "Session expired");
    }
    return storedSession.accessToken;
  }

  invalidateSession({ code = "AUTH_EXPIRED", message = "Session expired" } = {}) {
    this._advanceAuthEpoch();
    const storedSession = tokenStore.getSession();
    if (!storedSession?.refreshToken) {
      this._setStatus("signed-out", { errorCode: code, errorMessage: message });
      return;
    }
    this._preserveSessionAfterRefreshFailure(
      new DesktopAuthError(code, message),
      storedSession
    );
  }

  async deleteAccount() {
    await shell.openExternal(`${this.authOrigin}/app/settings?section=account`, { activate: true });
    return { success: true, openedBrowser: true };
  }

  async logout() {
    const storedSession = tokenStore.getSession();
    this._advanceAuthEpoch();
    this._closeLoopbackCallbackServer();
    tokenStore.clearSession();
    tokenStore.clearPending();
    clearTimeout(this.pendingExpiryTimer);
    this._setStatus("signed-out");
    if (!storedSession) {
      return { success: true, revoked: false };
    }
    const revoked = await this._revokeSessionSnapshot(storedSession);
    return { success: true, revoked };
  }

  async _revokeSessionSnapshot(storedSession) {
    if (!storedSession) return false;
    let revoked = false;
    try {
      if (storedSession?.accessToken) {
        await this._request("/api/v2/auth/desktop/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${storedSession.accessToken}` },
          body: JSON.stringify({
            refresh_token: storedSession.refreshToken,
            installation_id: tokenStore.getInstallationId(),
          }),
        }, { expectedStatus: 204, body: "empty" });
        revoked = true;
      }
    } catch (error) {
      if (![400, 401, 403].includes(Number(error?.httpStatus))) {
        authLogger.warn("logout_revocation_failed", {
          errorCode: error.code || "AUTH_LOGOUT_FAILED",
          httpStatus: error.httpStatus,
          requestId: error.requestId,
        });
      }
    }
    return revoked;
  }
}

module.exports = DesktopAuthManager;
module.exports.DesktopAuthError = DesktopAuthError;
module.exports.normalizedUser = normalizedUser;
