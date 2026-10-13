const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const API_BASE_URL = "https://api.voicelab.test";
const DESKTOP_STT_URL = `${API_BASE_URL}/v1/desktop/stt`;
const DESKTOP_USAGE_URL = `${API_BASE_URL}/v1/desktop/usage`;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function loadClient(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "voicelab-desktop-stt-test-"));
  const clientPath = require.resolve("../../src/helpers/voiceLabApiClient");
  const storePath = require.resolve("../../src/helpers/dictationOperationStore");
  const originalLoad = Module._load;

  try {
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === "electron") return { app: { getPath: () => userData } };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[clientPath];
    delete require.cache[storePath];
    return require(clientPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => {
      delete require.cache[clientPath];
      delete require.cache[storePath];
      fs.rmSync(userData, { recursive: true, force: true });
    });
  }
}

function createAuthManager() {
  const state = {
    accessToken: "desktop-access-token-1",
    accountId: "account-7",
    sessionId: "session-4",
    getValidAccessTokenCalls: 0,
    refreshCalls: 0,
    refreshOptions: [],
    invalidateCalls: 0,
    invalidations: [],
  };
  return {
    state,
    async getValidAccessToken() {
      state.getValidAccessTokenCalls += 1;
      return state.accessToken;
    },
    getSessionMetadata() {
      return {
        accountId: state.accountId,
        installationId: "install-9",
        sessionId: state.sessionId,
      };
    },
    async refreshSession(options) {
      state.refreshCalls += 1;
      state.refreshOptions.push(options);
      state.accessToken = "desktop-access-token-2";
    },
    invalidateSession(details) {
      state.invalidateCalls += 1;
      state.invalidations.push(details);
    },
  };
}

function createClient(VoiceLabApiClient, authManager = createAuthManager()) {
  const client = new VoiceLabApiClient({
    authManager,
    apiBaseUrl: `${API_BASE_URL}/`,
    billingOrigin: "https://voicelab.test/",
    appVersion: "1.7.15",
    channel: "test",
  });
  return { client, authManager };
}

function primeActiveSubscription(client) {
  client.getDesktopUsage = async () => ({
    entitlement: {
      active: true,
      planId: "plan_pro",
      planName: "Pro",
      usageWindow: "day",
      usageLimitSeconds: 28_800,
      usedSeconds: 842,
      reservedSeconds: 0,
      remainingSeconds: 27_958,
      maxRequestSeconds: null,
      windowStartsAt: "2026-08-22T00:00:00Z",
      resetsAt: "2026-08-23T00:00:00Z",
    },
    requestId: "req_subscription_cached",
  });
}

function installFetch(t, implementation) {
  const originalFetch = global.fetch;
  global.fetch = implementation;
  t.after(() => {
    global.fetch = originalFetch;
  });
}

function operation(overrides = {}) {
  return {
    operationId: "local-operation-1",
    accountId: "account-7",
    language: "uz",
    durationMs: 1_250,
    ...overrides,
  };
}

function assertNoForbiddenMultipartHeaders(init) {
  const headers = new Headers(init.headers);
  assert.equal(headers.has("content-type"), false, "fetch must generate the multipart boundary");
  assert.equal(headers.has("content-length"), false, "fetch must calculate Content-Length");
  assert.equal(headers.has("idempotency-key"), false, "desktop STT has no idempotency key");
}

test("desktop plan purchase always opens the normal website billing flow", (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);

  assert.equal(client.getBillingUrl("dictate"), "https://voicelab.test/app/billing?source=desktop");
  assert.equal(client.getBillingUrl("desktop"), "https://voicelab.test/app/billing?source=desktop");
});

test("desktop subscription uses the desktop token and preserves desktop STT entitlement", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      desktop_stt: {
        enabled: true,
        plan_id: "plan_pro",
        plan_name: "Pro",
        usage_window: "day",
        usage_limit_seconds: 28_800,
        used_seconds: 842,
        reserved_seconds: 0,
        remaining_seconds: 27_958,
        max_request_seconds: 300,
        window_starts_at: "2026-08-22T00:00:00Z",
        resets_at: "2026-08-23T00:00:00Z",
      },
      request_id: "req_subscription_1",
    });
  });

  assert.deepEqual(await client.getDesktopUsage(), {
    entitlement: {
      active: true,
      planId: "plan_pro",
      planName: "Pro",
      usageWindow: "day",
      usageLimitSeconds: 28_800,
      usedSeconds: 842,
      reservedSeconds: 0,
      remainingSeconds: 27_958,
      maxRequestSeconds: null,
      windowStartsAt: "2026-08-22T00:00:00Z",
      resetsAt: "2026-08-23T00:00:00Z",
    },
    requestId: "req_subscription_1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DESKTOP_USAGE_URL);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(
    new Headers(calls[0].init.headers).get("authorization"),
    "Bearer desktop-access-token-1"
  );
  assert.equal(new Headers(calls[0].init.headers).get("x-voicelab-installation-id"), null);
  assert.equal(authManager.state.getValidAccessTokenCalls, 1);
});

test("desktop usage refreshes once on an invalid token, then starts session recovery", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(
      {
        message: "Desktop session expired.",
        error: { code: "invalid_desktop_token" },
        request_id: "req_subscription_expired",
      },
      401
    );
  });

  await assert.rejects(
    client.getDesktopUsage(),
    (error) =>
      error.code === "AUTH_EXPIRED" &&
      error.status === 401 &&
      error.toPublic().requestId === "req_subscription_expired"
  );
  assert.equal(calls.length, 2);
  assert.equal(authManager.state.refreshCalls, 1);
  assert.equal(authManager.state.invalidateCalls, 1);
  assert.equal(authManager.state.invalidations[0]?.code, "invalid_desktop_token");
});

test("desktop subscription keeps enabled false authoritative without plan fields", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      desktop_stt: { enabled: false },
      request_id: "req_subscription_inactive",
    })
  );

  const result = await client.getDesktopUsage();
  assert.equal(result.entitlement.active, false);
  assert.equal(result.entitlement.planId, null);
  assert.equal(result.entitlement.usageLimitSeconds, 0);
  assert.equal(result.entitlement.maxRequestSeconds, null);
});

test("desktop usage accepts omitted zero counters for an enabled Free plan", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      desktop_stt: {
        enabled: true,
        plan_id: "plan_free",
        plan_name: "Free",
        usage_window: "day",
        usage_limit_seconds: 480,
        remaining_seconds: 480,
        window_starts_at: "2026-08-22T00:00:00Z",
        resets_at: "2026-08-23T00:00:00Z",
      },
      request_id: "req_free_zero_counters",
    })
  );

  const result = await client.getDesktopUsage();
  assert.equal(result.entitlement.active, true);
  assert.equal(result.entitlement.planId, "plan_free");
  assert.equal(result.entitlement.usedSeconds, 0);
  assert.equal(result.entitlement.reservedSeconds, 0);
  assert.equal(result.entitlement.remainingSeconds, 480);
});

test("desktop subscription rejects obsolete hourly usage windows", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  let calls = 0;
  installFetch(t, async (_url, init) => {
    calls += 1;
    assert.equal(init.cache, "no-store");
    return jsonResponse({
      desktop_stt: {
        enabled: true,
        plan_id: "plan_hourly",
        plan_name: "Hourly",
        usage_window: "hour",
        usage_limit_seconds: 3_600,
        used_seconds: calls,
        reserved_seconds: 0,
        remaining_seconds: 3_600 - calls,
        max_request_seconds: 120,
        window_starts_at: "2026-08-22T12:00:00Z",
        resets_at: "2026-08-22T13:00:00Z",
      },
      request_id: `req_subscription_hour_${calls}`,
    });
  });

  await assert.rejects(client.getDesktopUsage(), (error) => {
    assert.equal(error.code, "BACKEND_RESPONSE_INVALID");
    return true;
  });
  assert.equal(calls, 1);
});

test("desktop usage accepts an admin-lowered limit with zero remaining", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      desktop_stt: {
        enabled: true,
        plan_id: "plan_adjusted",
        plan_name: "Adjusted",
        usage_window: "day",
        usage_limit_seconds: 60,
        used_seconds: 75,
        reserved_seconds: 3,
        remaining_seconds: 0,
        window_starts_at: "2026-08-22T00:00:00Z",
        resets_at: "2026-08-23T00:00:00Z",
      },
      request_id: "req_adjusted_limit",
    })
  );

  const result = await client.getDesktopUsage();
  assert.equal(result.entitlement.usedSeconds, 75);
  assert.equal(result.entitlement.remainingSeconds, 0);
});

test("desktop subscription rejects malformed active usage windows", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      desktop_stt: {
        enabled: true,
        plan_id: "plan_pro",
        plan_name: "Pro",
        usage_window: "week",
        usage_limit_seconds: 28_800,
        used_seconds: 842,
        reserved_seconds: 0,
        remaining_seconds: 27_958,
        max_request_seconds: 300,
        window_starts_at: "2026-08-22T00:00:00Z",
        resets_at: "2026-08-23T00:00:00Z",
      },
      request_id: "req_subscription_invalid",
    })
  );

  await assert.rejects(
    client.getDesktopUsage(),
    (error) => error.code === "BACKEND_RESPONSE_INVALID"
  );
});

test("desktop STT sends one exact multipart request and exposes synchronous usage", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  const serverPayload = {
    text: "Assalomu alaykum",
    language: "uz",
    duration_ms: 1_250,
    usage: {
      used_seconds: 31,
      limit_seconds: 600,
      remaining_seconds: 569,
      usage_window: "day",
    },
    request_id: "req_desktop_stt_1",
    stt_provider: "openwhispr",
  };
  const expectedResponse = {
    text: serverPayload.text,
    language: serverPayload.language,
    duration_ms: serverPayload.duration_ms,
    usage: serverPayload.usage,
    request_id: serverPayload.request_id,
  };
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, DESKTOP_STT_URL);
    assert.equal(init.method, "POST");
    return jsonResponse(serverPayload);
  });

  const response = await client.sendDictationChunk(
    operation(),
    Buffer.from("webm audio bytes"),
    {
      contentType: "audio/webm",
      fileName: "dictation.webm",
      includeSpeakers: true,
      include_speakers: true,
    },
    0,
    1
  );

  assert.deepEqual(response, expectedResponse);
  assert.equal(calls.length, 1, "a synchronous response must not start a polling request");
  assert.equal(
    calls.some(({ init }) => init.method === "GET"),
    false
  );

  const request = calls[0];
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("authorization"), "Bearer desktop-access-token-1");
  assert.equal(headers.get("x-voicelab-client"), null);
  assert.equal(headers.get("x-voicelab-installation-id"), null);
  assertNoForbiddenMultipartHeaders(request.init);
  assert.ok(request.init.body instanceof FormData);
  assert.deepEqual([...request.init.body.keys()], ["audio", "language"]);
  assert.equal(request.init.body.getAll("audio").length, 1);
  assert.equal(request.init.body.getAll("language").length, 1);
  assert.equal(request.init.body.get("language"), "uz");
  assert.equal(request.init.body.get("include_speakers"), null);

  const audio = request.init.body.get("audio");
  assert.ok(audio instanceof Blob);
  assert.equal(audio.type, "audio/webm");
  assert.equal(audio.name, "audio.webm");

  const publicResult = await client.publicResult(response, "local-operation-1");
  assert.equal(publicResult.success, true);
  assert.equal(publicResult.text, serverPayload.text);
  assert.equal(publicResult.audioDurationMs, serverPayload.duration_ms);
  assert.equal(publicResult.requestId, serverPayload.request_id);
  assert.deepEqual(publicResult.usage, serverPayload.usage);
  assert.equal(publicResult.source, "voicelab");
  assert.equal(publicResult.sttProvider, "voicelab");
  for (const legacyCreditField of [
    "chargedCredits",
    "isUnlimited",
    "balanceCredits",
    "reservedCredits",
    "availableCredits",
  ]) {
    assert.equal(legacyCreditField in publicResult, false);
  }
});

test("desktop STT rejects the ordinary website STT response shape", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      id: 77,
      transcript: "Fallback ishladi",
      language: "uz",
      duration: 1.25,
      request_id: "req_legacy_fallback",
    })
  );

  await assert.rejects(
    client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
      contentType: "audio/mpeg",
      fileName: "audio.mp3",
    }),
    (error) =>
      error.code === "BACKEND_RESPONSE_INVALID" &&
      error.toPublic().requestId === "req_legacy_fallback"
  );
});

test("desktop STT rejects every non-JSON success response", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  let responseKind = "plain";
  installFetch(t, async () => {
    if (responseKind === "plain") {
      return new Response("Oddiy matn natijasi", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-request-id": "req_plain_fallback",
        },
      });
    }
    return new Response("<html><body>Bad gateway</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-request-id": "req_html_rejected",
      },
    });
  });

  await assert.rejects(
    client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
      contentType: "audio/mpeg",
      fileName: "audio.mp3",
    }),
    (error) =>
      error.code === "BACKEND_RESPONSE_INVALID" &&
      error.toPublic().requestId === "req_plain_fallback"
  );

  responseKind = "html";
  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "audio.mp3",
      }),
    (error) =>
      error.code === "BACKEND_RESPONSE_INVALID" &&
      error.status === 200 &&
      error.toPublic().requestId === "req_html_rejected"
  );
});

test("invalid desktop token refreshes once and rebuilds multipart for one retry", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return jsonResponse(
        {
          error: { code: "invalid_desktop_token", message: "Desktop token expired" },
          request_id: "req_auth_1",
        },
        401
      );
    }
    return jsonResponse({
      text: "Yangilangan token bilan",
      language: "uz",
      duration_ms: 900,
      usage: {
        used_seconds: 1,
        limit_seconds: 600,
        remaining_seconds: 599,
        usage_window: "day",
      },
      request_id: "req_auth_2",
    });
  });

  const result = await client.sendDictationChunk(
    operation({ durationMs: 900 }),
    Buffer.from("audio bytes"),
    { contentType: "audio/mpeg", fileName: "retry.mp3" }
  );

  assert.equal(result.request_id, "req_auth_2");
  assert.equal(authManager.state.refreshCalls, 1);
  assert.equal(authManager.state.refreshOptions[0]?.force, true);
  assert.equal(authManager.state.getValidAccessTokenCalls, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [DESKTOP_STT_URL, DESKTOP_STT_URL]
  );
  assert.equal(
    new Headers(calls[0].init.headers).get("authorization"),
    "Bearer desktop-access-token-1"
  );
  assert.equal(
    new Headers(calls[1].init.headers).get("authorization"),
    "Bearer desktop-access-token-2"
  );
  assert.notEqual(calls[0].init.body, calls[1].init.body, "FormData cannot be reused after retry");
  for (const { init } of calls) {
    assert.deepEqual([...init.body.keys()], ["audio", "language"]);
    assertNoForbiddenMultipartHeaders(init);
  }
});

test("refresh rate limits preserve Retry-After and request diagnostics without resending STT", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const authManager = createAuthManager();
  authManager.refreshSession = async () => {
    authManager.state.refreshCalls += 1;
    const error = new Error("Refresh is rate limited");
    error.code = "rate_limited";
    error.httpStatus = 429;
    error.requestId = "req_refresh_rate_limited";
    error.retryAfterSeconds = 9;
    error.fields = { refresh_token: "Try later" };
    throw error;
  };
  const { client } = createClient(VoiceLabApiClient, authManager);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    return jsonResponse(
      {
        error: { code: "invalid_desktop_token", message: "Desktop token expired" },
        request_id: "req_stt_needs_refresh",
      },
      401
    );
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "rate-limited-refresh.mp3",
      }),
    (error) => {
      const publicError = error.toPublic();
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.equal(publicError.requestId, "req_refresh_rate_limited");
      assert.equal(publicError.retryAfterSeconds, 9);
      assert.equal(publicError.serverCode, "rate_limited");
      return true;
    }
  );
  assert.equal(fetchCalls, 1);
  assert.equal(authManager.state.refreshCalls, 1);
});

test("a second invalid-token response stops after the single authorized retry", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    return jsonResponse(
      {
        error: { code: "invalid_desktop_token", message: "Desktop token expired" },
        request_id: `req_auth_${fetchCalls}`,
      },
      401
    );
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "retry.mp3",
      }),
    (error) => error.code === "AUTH_EXPIRED" && error.status === 401
  );
  assert.equal(fetchCalls, 2);
  assert.equal(authManager.state.refreshCalls, 1);
  assert.equal(authManager.state.getValidAccessTokenCalls, 2);
  assert.equal(authManager.state.invalidateCalls, 1);
  assert.equal(authManager.state.invalidations[0]?.code, "invalid_desktop_token");
});

test("undocumented desktop sync routes are disabled before network access", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(
      {
        error: { code: "invalid_desktop_token", message: "Not valid for this endpoint" },
        request_id: "req_non_stt_401",
      },
      401
    );
  });

  await assert.rejects(client.getSyncBootstrap(), {
    code: "DESKTOP_ENDPOINT_UNAVAILABLE",
    status: 501,
  });
  assert.equal(calls.length, 0);
  assert.equal(authManager.state.refreshCalls, 0);
  assert.equal(authManager.state.invalidateCalls, 0);
});

test("STT only refreshes for the exact invalid_desktop_token code", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    return jsonResponse(
      {
        error: { code: "INVALID_DESKTOP_TOKEN", message: "Wrong code casing" },
        request_id: "req_wrong_auth_code",
      },
      401
    );
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "no-refresh.mp3",
      }),
    (error) => error.code === "AUTH_EXPIRED" && error.status === 401
  );
  assert.equal(fetchCalls, 1);
  assert.equal(authManager.state.refreshCalls, 0);
  assert.equal(authManager.state.invalidateCalls, 0);
});

test("a stale retried STT response cannot invalidate a newer desktop session", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    if (fetchCalls === 2) {
      authManager.state.accessToken = "new-login-access-token";
      authManager.state.sessionId = "session-new-login";
    }
    return jsonResponse(
      {
        error: { code: "invalid_desktop_token", message: "Desktop token expired" },
        request_id: `req_stale_${fetchCalls}`,
      },
      401
    );
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "stale.mp3",
      }),
    (error) => error.code === "AUTH_EXPIRED" && error.status === 401
  );
  assert.equal(fetchCalls, 2);
  assert.equal(authManager.state.refreshCalls, 1);
  assert.equal(authManager.state.invalidateCalls, 0);
  assert.equal(authManager.state.sessionId, "session-new-login");
});

test("desktop STT errors preserve server semantics, Retry-After, and nested fields", async (t) => {
  const cases = [
    {
      name: "subscription required",
      status: 402,
      serverCode: "desktop_subscription_required",
      publicCode: "ENTITLEMENT_REQUIRED",
    },
    {
      name: "another dictation is active",
      status: 429,
      serverCode: "concurrent_dictation",
      publicCode: "CONCURRENCY_LIMIT",
    },
    {
      name: "desktop usage allowance is exhausted",
      status: 429,
      serverCode: "desktop_usage_limit_reached",
      publicCode: "DAILY_CAP_REACHED",
    },
    {
      name: "STT is overloaded",
      status: 429,
      serverCode: "stt_overloaded",
      publicCode: "RATE_LIMITED",
      retryAfter: "17",
      retryAfterSeconds: 17,
    },
    {
      name: "audio exceeds the duration limit",
      status: 413,
      serverCode: "audio_too_long",
      publicCode: "AUDIO_LIMIT_EXCEEDED",
      fields: { max_duration_seconds: 300 },
      maxDurationSeconds: 300,
    },
    {
      name: "audio format is unsupported",
      status: 415,
      serverCode: "unsupported_audio_format",
      publicCode: "AUDIO_INVALID",
    },
    {
      name: "request validation failed",
      status: 422,
      serverCode: "validation_error",
      publicCode: "INVALID_REQUEST",
    },
    {
      name: "no speech was detected",
      status: 422,
      serverCode: "no_speech_detected",
      publicCode: "NO_SPEECH_DETECTED",
    },
    {
      name: "desktop STT is temporarily unavailable",
      status: 503,
      serverCode: "desktop_stt_unavailable",
      publicCode: "SERVICE_UNAVAILABLE",
    },
    {
      name: "desktop STT timed out",
      status: 504,
      serverCode: "desktop_stt_timeout",
      publicCode: "SERVICE_UNAVAILABLE",
    },
  ];

  for (const errorCase of cases) {
    await t.test(errorCase.name, async (t) => {
      const VoiceLabApiClient = loadClient(t);
      const { client } = createClient(VoiceLabApiClient);
      let fetchCalls = 0;
      installFetch(t, async () => {
        fetchCalls += 1;
        return jsonResponse(
          {
            error: {
              code: errorCase.serverCode,
              message: errorCase.name,
              ...(errorCase.fields ? { fields: errorCase.fields } : {}),
            },
            request_id: `req_${errorCase.serverCode}`,
          },
          errorCase.status,
          errorCase.retryAfter ? { "retry-after": errorCase.retryAfter } : {}
        );
      });

      let thrown;
      try {
        await client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
          contentType: "audio/mpeg",
          fileName: "error.mp3",
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, "the non-2xx response must reject");
      assert.equal(fetchCalls, 1, "non-auth failures must never be retried automatically");
      assert.equal(thrown.code, errorCase.publicCode);
      assert.equal(thrown.status, errorCase.status);
      const publicError = thrown.toPublic();
      assert.equal(publicError.serverCode, errorCase.serverCode);
      assert.equal(publicError.requestId, `req_${errorCase.serverCode}`);
      assert.equal(publicError.retryAfterSeconds, errorCase.retryAfterSeconds ?? null);
      if (errorCase.maxDurationSeconds != null) {
        assert.equal(publicError.max_duration_seconds, errorCase.maxDurationSeconds);
      }
    });
  }
});

test("network ambiguity is surfaced without an automatic resend", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    throw new TypeError("connection reset after upload");
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "ambiguous.mp3",
      }),
    (error) => error.code === "SERVICE_UNAVAILABLE"
  );
  assert.equal(fetchCalls, 1);
  assert.equal(authManager.state.refreshCalls, 0);
});

test("desktop STT sends unknown MIME recordings unchanged for server sniffing", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  const original = Buffer.from("audio bytes");
  let upload;
  installFetch(t, async (_url, init) => {
    fetchCalls += 1;
    upload = init.body.get("audio");
    return jsonResponse({
      text: "Server sniffed audio",
      language: "uz",
      duration_ms: 900,
      usage: {
        used_seconds: 1,
        limit_seconds: 60,
        remaining_seconds: 59,
        usage_window: "day",
      },
      request_id: "req_sniffed_audio",
    });
  });

  await client.sendDictationChunk(operation(), original, {
    contentType: "application/octet-stream",
    fileName: "renamed.webm",
  });
  assert.equal(fetchCalls, 1);
  assert.equal(upload.type, "application/octet-stream");
  assert.equal(upload.name, "audio.bin");
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), original);
});

test("desktop STT uses canonical filenames for every supported MIME type", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  const requests = [];
  installFetch(t, async (_url, init) => {
    requests.push(init);
    return jsonResponse({
      text: "Test",
      language: "uz",
      duration_ms: 1_000,
      usage: {
        used_seconds: 1,
        limit_seconds: 60,
        remaining_seconds: 59,
        usage_window: "day",
      },
      request_id: `req_mime_${requests.length}`,
    });
  });
  const supported = [
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
  ];

  for (const [contentType, extension] of supported) {
    await client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
      contentType,
      fileName: "untrusted-name.bin",
    });
    const audio = requests.at(-1).body.get("audio");
    assert.equal(audio.type, contentType);
    assert.equal(audio.name, `audio.${extension}`);
    assert.deepEqual([...requests.at(-1).body.keys()], ["audio", "language"]);
  }
  assert.equal(requests.length, supported.length);
});

test("desktop STT rejects incomplete success usage without resending", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    return jsonResponse({
      text: "Assalomu alaykum",
      language: "uz",
      duration_ms: 1_000,
      usage: { used_seconds: 1, limit_seconds: 60 },
      request_id: "req_invalid_usage",
    });
  });

  await assert.rejects(
    () =>
      client.sendDictationChunk(operation(), Buffer.from("audio bytes"), {
        contentType: "audio/mpeg",
        fileName: "audio.mp3",
      }),
    (error) =>
      error.code === "BACKEND_RESPONSE_INVALID" &&
      error.toPublic().requestId === "req_invalid_usage"
  );
  assert.equal(fetchCalls, 1);
});

test("cancelling desktop STT aborts the active upload without retrying", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  primeActiveSubscription(client, authManager);
  const externalAbort = new AbortController();
  let fetchCalls = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  installFetch(
    t,
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        fetchCalls += 1;
        markStarted();
        init.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true }
        );
      })
  );

  const activeOperation = await client.beginDictation({
    audioBuffer: Buffer.from("audio bytes"),
    durationMs: 1_000,
    language: "uz",
  });
  const request = client.sendDictationChunk(activeOperation, Buffer.from("audio bytes"), {
    contentType: "audio/mpeg",
    fileName: "cancel.mp3",
    signal: externalAbort.signal,
  });
  await started;
  externalAbort.abort();

  await assert.rejects(request, (error) => error.code === "CANCELLED");
  client.failDictation(activeOperation, { code: "CANCELLED" });
  assert.equal(fetchCalls, 1);
  assert.equal(authManager.state.refreshCalls, 0);
});

test("desktop STT enforces only the documented 200 MiB client-side boundary", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  primeActiveSubscription(client, authManager);

  const serverValidatedDuration = await client.beginDictation({
    audioBuffer: Buffer.from("audio"),
    durationMs: 300_001,
    language: "uz",
  });
  client.finishDictation(serverValidatedDuration);

  let boundaryAudio = Buffer.alloc(MAX_AUDIO_BYTES);
  const sizeBoundary = await client.beginDictation({
    audioBuffer: boundaryAudio,
    durationMs: 1_000,
    language: "uz",
  });
  client.finishDictation(sizeBoundary);
  boundaryAudio = null;

  await assert.rejects(
    () =>
      client.beginDictation({
        audioBuffer: Buffer.alloc(MAX_AUDIO_BYTES + 1),
        durationMs: 1_000,
        language: "uz",
      }),
    (error) => error.code === "AUDIO_LIMIT_EXCEEDED" && error.status === 413
  );
});

test("desktop STT requires an active entitlement without inventing a request limit", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  installFetch(t, async () =>
    jsonResponse({
      desktop_stt: { enabled: false },
      request_id: "req_inactive_plan",
    })
  );

  await assert.rejects(
    () =>
      client.beginDictation({
        audioBuffer: Buffer.from("audio"),
        durationMs: 1_000,
        language: "uz",
      }),
    (error) =>
      error.code === "ENTITLEMENT_REQUIRED" &&
      error.status === 402 &&
      error.toPublic().requestId === "req_inactive_plan"
  );

  primeActiveSubscription(client, authManager);
  const operation = await client.beginDictation({
    audioBuffer: Buffer.from("audio"),
    durationMs: 120_001,
    language: "uz",
  });
  client.finishDictation(operation);
});

test("concurrent begin calls reserve the single dictation slot before usage resolves", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  let resolveUsage;
  client.getDesktopUsage = () =>
    new Promise((resolve) => {
      resolveUsage = resolve;
    });

  const first = client.beginDictation({
    audioBuffer: Buffer.from("first"),
    durationMs: 1_000,
    language: "uz",
  });
  await assert.rejects(
    client.beginDictation({
      audioBuffer: Buffer.from("second"),
      durationMs: 1_000,
      language: "uz",
    }),
    (error) => error.code === "CONCURRENCY_LIMIT"
  );
  resolveUsage({
    entitlement: { active: true },
    requestId: "req_usage_first",
  });
  const operation = await first;
  client.finishDictation(operation);
});

test("desktop onboarding read treats a missing profile as null and keeps the desktop boundary", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client, authManager } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return jsonResponse(
        {
          message: "No desktop onboarding profile has been saved for this account.",
          error: { code: "desktop_onboarding_not_found" },
          request_id: "req_onboarding_missing",
        },
        404
      );
    }
    return jsonResponse({
      onboarding: {
        role: "developer",
        use_cases: ["coding", "fax", "messages"],
        dictation_language: "uz",
        writing_style: "formal",
        ui_language: "uz",
        theme: "dark",
        app_version: "1.2.2",
        platform: "darwin",
        revision: 3,
        completed_at: "2026-10-13T01:40:00Z",
        updated_at: "2026-10-13T02:40:00Z",
      },
      request_id: "req_onboarding_read",
    });
  });

  assert.equal(await client.getDesktopOnboarding(), null);
  const profile = await client.getDesktopOnboarding();
  assert.deepEqual(profile, {
    role: "developer",
    useCases: ["coding", "messages"],
    dictationLanguage: "uz",
    writingStyle: "formal",
    uiLanguage: "uz",
    theme: "dark",
    appVersion: "1.2.2",
    platform: "darwin",
    revision: 3,
    completedAt: "2026-10-13T01:40:00Z",
    updatedAt: "2026-10-13T02:40:00Z",
    requestId: "req_onboarding_read",
  });
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, `${API_BASE_URL}/v1/desktop/onboarding`);
    assert.equal(init.method, "GET");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer desktop-access-token-1");
    assert.equal(headers.has("x-voicelab-client"), false);
    assert.equal(headers.has("x-voicelab-installation-id"), false);
    assert.equal(headers.has("content-type"), false);
  }
  assert.equal(authManager.state.refreshCalls, 0);
});

test("desktop onboarding save sends one exact JSON body and surfaces validation fields", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return jsonResponse({
        onboarding: {
          role: "developer",
          use_cases: ["coding"],
          dictation_language: "auto",
          revision: 1,
          completed_at: "2026-10-13T01:40:00Z",
          updated_at: "2026-10-13T01:40:02Z",
        },
        request_id: "req_onboarding_saved",
      });
    }
    return jsonResponse(
      {
        message: "Some onboarding answers are not valid.",
        error: { code: "validation_error", fields: { role: "Choose one of the listed roles." } },
        request_id: "req_onboarding_invalid",
      },
      422
    );
  });

  const saved = await client.saveDesktopOnboarding({
    role: " Developer ",
    useCases: ["Coding", "coding", ""],
    dictationLanguage: "",
    writingStyle: "",
    uiLanguage: "en-US",
    theme: "dark",
    completedAt: "2026-10-13T01:40:00Z",
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.role, "developer");
  assert.equal(saved.writingStyle, "");
  assert.equal(saved.dictationLanguage, "auto");
  assert.equal(saved.requestId, "req_onboarding_saved");

  assert.equal(calls[0].url, `${API_BASE_URL}/v1/desktop/onboarding`);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    role: "developer",
    use_cases: ["coding"],
    dictation_language: "auto",
    writing_style: "",
    ui_language: "en-us",
    theme: "dark",
    app_version: "1.7.15",
    platform: process.platform,
    completed_at: "2026-10-13T01:40:00Z",
  });

  await assert.rejects(
    client.saveDesktopOnboarding({ role: "wizard" }),
    (error) =>
      error.code === "INVALID_REQUEST" &&
      error.status === 422 &&
      error.details.error.fields.role === "Choose one of the listed roles."
  );
  assert.equal(calls.length, 2);
});

test("meeting segments add the purpose field and accept a response without a saved record", async (t) => {
  const VoiceLabApiClient = loadClient(t);
  const { client } = createClient(VoiceLabApiClient);
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      text: "meeting fixture",
      language: "uz",
      duration_ms: 6500,
      audio_available: false,
      usage: {
        used_seconds: 7,
        usage_window: "day",
        limit_seconds: 28_800,
        remaining_seconds: 28_793,
      },
      request_id: "req_meeting_chunk",
    });
  });

  const response = await client.sendDictationChunk(operation(), new Uint8Array([1, 2, 3]), {
    contentType: "audio/wav",
    purpose: "meeting",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DESKTOP_STT_URL);
  assert.deepEqual([...calls[0].init.body.keys()], ["audio", "language", "purpose"]);
  assert.equal(calls[0].init.body.get("purpose"), "meeting");
  assert.equal(response.text, "meeting fixture");
  assert.equal("id" in response, false);
  const publicResult = await client.publicResult(response, "local-operation-1");
  assert.equal(publicResult.desktopTranscriptionId, null);
  assert.equal(publicResult.desktopAudioAvailable, false);
  assert.equal(publicResult.audioDurationMs, 6500);

  calls.length = 0;
  await client.sendDictationChunk(operation(), new Uint8Array([1, 2, 3]), {
    contentType: "audio/wav",
  });
  assert.deepEqual([...calls[0].init.body.keys()], ["audio", "language"]);
});
