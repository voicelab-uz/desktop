const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const INSTALLATION_ID = "0191f85b-7b5d-7f2a-8d71-2f5ea87cdf77";
const REQUEST_ID = `dau_${"r".repeat(43)}`;
const CALLBACK_CODE = `dac_${"c".repeat(43)}`;

const successfulTokens = () => ({
  access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
  refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
  session_id: "desktop-session-recovered",
  user: { id: "user-recovered", email: "recovered@example.com" },
});

function loopbackCallback(pending, { code = CALLBACK_CODE, state = pending.state } = {}) {
  const url = new URL(pending.redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

function jsonResponse(status, body, headers = {}) {
  let payload = body;
  if (body && typeof body === "object") {
    payload = { request_id: "req_test_auth", ...body };
    if (payload.authorization_request_id) payload.expires_in ??= 600;
    if (payload.access_token) {
      payload.token_type ??= "Bearer";
      payload.expires_in ??= 900;
      payload.refresh_expires_in ??= 3600;
      payload.session_id ??= "dss_test_auth";
    }
  }
  return new Response(payload == null ? null : JSON.stringify(payload), {
    status,
    headers: payload == null ? headers : { "Content-Type": "application/json", ...headers },
  });
}

function loadDesktopAuthManager(initialSession = null, { openExternal: openExternalImpl } = {}) {
  const modulePath = require.resolve("../../src/helpers/desktopAuthManager");
  delete require.cache[modulePath];
  let pending = null;
  let storedSession = initialSession ? { ...initialSession } : null;
  let openedUrl = null;
  let openCount = 0;
  const tokenStore = {
    getInstallationId: () => INSTALLATION_ID,
    getSession: () => (storedSession ? { ...storedSession } : null),
    saveSession: (value) => {
      storedSession = { ...value };
    },
    clearSession: () => {
      storedSession = null;
    },
    getPending: () => (pending ? { ...pending } : null),
    savePending: (value) => {
      pending = { ...value };
    },
    clearPending: () => {
      pending = null;
    },
    completeAuthorization: (value) => {
      storedSession = { ...value };
      pending = null;
    },
  };
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        shell: {
          openExternal: async (url) => {
            openedUrl = url;
            openCount += 1;
            return openExternalImpl?.(url);
          },
        },
      };
    }
    if (request === "./tokenStore") return tokenStore;
    if (request === "./authLogger") return { warn: () => {}, info: () => {} };
    if (request === "os") return { hostname: () => "  Studio\u0000 \u202e Workstation\n" };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return {
      DesktopAuthManager: require(modulePath),
      getOpenedUrl: () => openedUrl,
      getOpenCount: () => openCount,
      getPending: () => pending,
      getStoredSession: () => storedSession,
      expirePending: () => {
        pending.expiresAt = Date.now() - 1;
      },
    };
  } finally {
    Module._load = originalLoad;
  }
}

function managerFrom(DesktopAuthManager, { useCustomProtocol = false } = {}) {
  return new DesktopAuthManager({
    channel: "production",
    scheme: "voicelab",
    appVersion: "1.8.0",
    apiBaseUrl: "https://api.voicelab.uz",
    authWebBaseUrl: "https://voicelab.uz",
    authorizationOrigins: ["https://voicelab.uz"],
    useCustomProtocol,
  });
}

for (const operation of ["start", "reopen"]) {
  for (const terminalState of [
    "cancelled",
    "expired",
    "authenticated",
    "authenticated-browser-error",
  ]) {
    test(`${operation} browser completion cannot overwrite ${terminalState}`, async (t) => {
      let completeOpen;
      let openCount = 0;
      const { DesktopAuthManager, getPending, expirePending } = loadDesktopAuthManager(null, {
        openExternal: () => {
          openCount += 1;
          if (operation === "reopen" && openCount === 1) return;
          return new Promise((resolve, reject) => {
            completeOpen = () =>
              terminalState.endsWith("browser-error")
                ? reject(new Error("late browser error"))
                : resolve();
          });
        },
      });
      const manager = managerFrom(DesktopAuthManager, { useCustomProtocol: true });
      t.after(() => manager.cancelAuthorization());
      t.mock.method(global, "fetch", async (url) =>
        url.endsWith("/authorizations")
          ? jsonResponse(201, {
              authorization_request_id: REQUEST_ID,
              authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
            })
          : jsonResponse(200, successfulTokens())
      );
      if (operation === "reopen") await manager.startAuthorization();
      const opening =
        operation === "start" ? manager.startAuthorization() : manager.reopenAuthorization();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof completeOpen, "function");
      if (terminalState === "cancelled") manager.cancelAuthorization();
      else if (terminalState === "expired") {
        expirePending();
        manager._schedulePendingExpiry(Date.now() - 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await manager.handleCallback(loopbackCallback(getPending()));
      }
      completeOpen();
      const expected = terminalState.startsWith("authenticated") ? "authenticated" : terminalState;
      assert.equal((await opening).status, expected);
      assert.equal(manager.getPublicStatus().status, expected);
      assert.equal(getPending(), null);
    });
  }
}

test("loopback exchange retry keeps the registered callback listener reachable", async (t) => {
  const originalFetch = global.fetch;
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  t.after(() => manager.cancelAuthorization());
  let exchanges = 0;
  t.mock.method(global, "fetch", async (url) => {
    if (url.endsWith("/authorizations"))
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    exchanges += 1;
    return exchanges === 1
      ? jsonResponse(503, { error: { code: "auth_unavailable" } }, { "Retry-After": "1" })
      : jsonResponse(200, successfulTokens());
  });
  await manager.startAuthorization();
  const callback = loopbackCallback(getPending());
  const first = await originalFetch(callback);
  await first.text();
  assert.equal(first.status, 400);
  assert.equal(manager.getPublicStatus().status, "waiting-for-browser");
  assert.ok(manager.callbackServer?.listening);
  await manager.reopenAuthorization();
  assert.equal(loopbackCallback(getPending()), callback);
  const second = await originalFetch(callback);
  await second.text();
  assert.equal(second.status, 200);
  assert.equal(exchanges, 2);
  assert.equal(getStoredSession().sessionId, "desktop-session-recovered");
  assert.equal(manager.callbackServer, null);
});

test("starts system-browser PKCE authorization through the exact Go contract", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getOpenedUrl, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });
  };

  const status = await manager.startAuthorization();

  assert.equal(status.status, "waiting-for-browser");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.voicelab.uz/api/v2/auth/desktop/authorizations");
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.client_id, "voicelab-desktop");
  assert.match(request.redirect_uri, /^http:\/\/127\.0\.0\.1:\d{4,5}\/callback$/);
  const redirectPort = Number(new URL(request.redirect_uri).port);
  assert.ok(redirectPort >= 1024 && redirectPort <= 65535);
  assert.equal(request.code_challenge_method, "S256");
  assert.match(request.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(getPending().codeVerifier.length, 43);
  assert.match(getPending().codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(request.state.length, 43);
  assert.match(request.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    request.code_challenge,
    require("node:crypto")
      .createHash("sha256")
      .update(getPending().codeVerifier)
      .digest("base64url")
  );
  assert.deepEqual(Object.keys(request).sort(), [
    "app_version",
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "device_name",
    "installation_id",
    "platform",
    "redirect_uri",
    "state",
  ]);
  assert.equal(request.installation_id, INSTALLATION_ID);
  assert.equal(request.device_name, "Studio Workstation");
  assert.equal(request.app_version, "1.8.0");
  assert.equal(request.platform, process.platform === "win32" ? "windows" : process.platform);
  assert.equal(getPending().authorizationRequestId, REQUEST_ID);
  assert.equal(getOpenedUrl(), `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`);
  assert.equal(new URL(getOpenedUrl()).pathname, "/app/sign-in");
  assert.equal(new URL(getOpenedUrl()).searchParams.get("desktop_auth_id"), REQUEST_ID);
  assert.equal(new URL(getOpenedUrl()).searchParams.get("state"), null);
});

test("uses the registered VoiceLab protocol callback when the OS handler is available", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager, { useCustomProtocol: true });
  let authorizationRequest = null;
  global.fetch = async (_url, init) => {
    authorizationRequest = JSON.parse(init.body);
    return jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });
  };

  await manager.startAuthorization();

  assert.equal(authorizationRequest.redirect_uri, "voicelab://auth/callback");
  assert.equal(getPending().redirectUri, "voicelab://auth/callback");
  assert.equal(manager.callbackServer, null);
});

test("registered protocol callback exchanges code and PKCE verifier", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager, { useCustomProtocol: true });
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
        expires_in: 600,
      });
    }
    return jsonResponse(200, {
      access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
      refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
      expires_in: 900,
      refresh_expires_in: 3600,
      session_id: "desktop-session-custom-protocol",
      user: { id: "user-7", email: "desktop@example.com" },
    });
  };

  await manager.startAuthorization();
  const pending = getPending();
  const status = await manager.handleCallback(
    `voicelab://auth/callback?code=${CALLBACK_CODE}&state=${pending.state}`
  );

  assert.equal(status.status, "authenticated");
  assert.equal(JSON.parse(calls[1].init.body).redirect_uri, "voicelab://auth/callback");
  assert.equal(getStoredSession().sessionId, "desktop-session-custom-protocol");
});

test("reopens and cancels an existing authorization without replacing PKCE state", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getOpenCount, getOpenedUrl, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let authorizationRequests = 0;
  global.fetch = async () => {
    authorizationRequests += 1;
    return jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });
  };

  await manager.startAuthorization();
  const originalPending = getPending();
  await manager.startAuthorization();

  assert.equal(authorizationRequests, 1);
  assert.equal(getOpenCount(), 2);
  assert.equal(getPending().state, originalPending.state);
  assert.equal(new URL(getOpenedUrl()).searchParams.get("desktop_auth_id"), REQUEST_ID);

  const cancelled = manager.cancelAuthorization();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorCode, "AUTH_CANCELLED_BY_USER");
  assert.equal(getPending(), null);
});

test("recovers a stale opening-browser state by starting a real browser authorization", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getOpenCount } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  manager.status = "opening-browser";
  global.fetch = async () =>
    jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });

  const status = await manager.startAuthorization();

  assert.equal(status.status, "waiting-for-browser");
  assert.equal(getOpenCount(), 1);
});

test("shares concurrent browser authorization attempts instead of reporting a phantom opening state", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getOpenCount } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let resolveAuthorization;
  let authorizationRequests = 0;
  global.fetch = () => {
    authorizationRequests += 1;
    return new Promise((resolve) => {
      resolveAuthorization = resolve;
    });
  };

  const first = manager.startAuthorization();
  const second = manager.startAuthorization();
  assert.strictEqual(second, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorizationRequests, 1);

  resolveAuthorization(
    jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    })
  );
  const status = await first;

  assert.equal(status.status, "waiting-for-browser");
  assert.equal(getOpenCount(), 1);
});

test("surfaces browser launch failures instead of leaving sign-in loading", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending } = loadDesktopAuthManager(null, {
    openExternal: async () => {
      throw new Error("No browser available");
    },
  });
  const manager = managerFrom(DesktopAuthManager);
  global.fetch = async () =>
    jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });

  await assert.rejects(manager.startAuthorization(), {
    message: "No browser available",
  });
  assert.equal(manager.getPublicStatus().status, "error");
  assert.equal(manager.getPublicStatus().errorCode, "AUTH_START_FAILED");
  assert.equal(getPending(), null);
});

test("times out a hung browser launch instead of leaving sign-in loading", async (t) => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  t.after(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
  global.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args);

  const { DesktopAuthManager, getPending } = loadDesktopAuthManager(null, {
    openExternal: () => new Promise(() => {}),
  });
  const manager = managerFrom(DesktopAuthManager);
  global.fetch = async () =>
    jsonResponse(201, {
      authorization_request_id: REQUEST_ID,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      expires_in: 600,
    });

  await assert.rejects(manager.startAuthorization(), {
    code: "AUTH_BROWSER_OPEN_TIMEOUT",
    message: "Could not open your browser. Please try again.",
  });
  assert.deepEqual(manager.getPublicStatus(), {
    status: "error",
    user: null,
    errorCode: "AUTH_BROWSER_OPEN_TIMEOUT",
    errorMessage: "Could not open your browser. Please try again.",
  });
  assert.equal(getPending(), null);
});

test("surfaces the exact sanitized backend failure alongside its stable error code", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  global.fetch = async () =>
    new Response("upstream returned HTML", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });

  await assert.rejects(manager.startAuthorization(), {
    code: "AUTH_BACKEND_RESPONSE_INVALID",
    message: "Authentication server returned an invalid response",
  });
  assert.deepEqual(manager.getPublicStatus(), {
    status: "error",
    user: null,
    errorCode: "AUTH_BACKEND_RESPONSE_INVALID",
    errorMessage: "Authentication server returned an invalid response",
  });
});

test("preserves backend code, safe field errors, request id, and retry timing", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        message: "Check the highlighted fields.\n",
        error: {
          code: "validation_error",
          fields: { platform: "Use darwin, windows, or linux.\u0000" },
        },
        request_id: "req_contract_422",
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json", "Retry-After": "7" },
      }
    );

  await assert.rejects(manager.startAuthorization(), (error) => {
    assert.equal(error.code, "validation_error");
    assert.equal(error.message, "Check the highlighted fields.");
    assert.equal(error.requestId, "req_contract_422");
    assert.deepEqual(error.fields, { platform: "Use darwin, windows, or linux." });
    assert.equal(error.retryAfterSeconds, 7);
    return true;
  });
  assert.deepEqual(manager.getPublicStatus(), {
    status: "error",
    user: null,
    errorCode: "validation_error",
    errorMessage: "Check the highlighted fields.",
    errorRequestId: "req_contract_422",
    errorFields: { platform: "Use darwin, windows, or linux." },
    retryAfterSeconds: 7,
  });
});

test("rejects untrusted, unbound, or extra authorization URL values", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getOpenedUrl, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);

  for (const makeUrl of [
    () => `https://evil.example/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
    () => `https://voicelab.uz/app/home?desktop_auth_id=${REQUEST_ID}`,
    () => `https://voicelab.uz/app/sign-in?desktop_auth_id=tampered`,
    () => `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}&next=https://evil.example`,
    (state) => `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}&state=${state}`,
  ]) {
    global.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: makeUrl(request.state),
        expires_in: 600,
      });
    };
    await assert.rejects(manager.startAuthorization(), (error) => {
      assert.match(error.code, /^AUTHORIZATION_(?:ORIGIN_REJECTED|URL_INVALID)$/);
      return true;
    });
    assert.equal(getOpenedUrl(), null);
    assert.equal(getPending(), null);
  }

  global.fetch = async () => {
    const legacyId = "3b1715a0-75c2-4fd4-bdd8-a7bfb42a9e65";
    return jsonResponse(201, {
      authorization_request_id: legacyId,
      authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${legacyId}`,
    });
  };
  await assert.rejects(
    manager.startAuthorization(),
    (error) => error.code === "AUTHORIZATION_RESPONSE_INVALID"
  );
});

test("loopback callback exchanges code and PKCE verifier without browser cookies", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
        expires_in: 600,
      });
    }
    return jsonResponse(200, {
      access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
      refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
      expires_in: 900,
      refresh_expires_in: 3600,
      session_id: "desktop-session-1",
      user: { id: "user-7", email: "desktop@example.com" },
    });
  };
  await manager.startAuthorization();
  const pending = getPending();

  const status = await manager.handleCallback(loopbackCallback(pending));

  assert.equal(status.status, "authenticated");
  const exchange = calls[1];
  assert.equal(exchange.url, "https://api.voicelab.uz/api/v2/auth/desktop/token");
  assert.equal(exchange.init.credentials, undefined);
  assert.equal(exchange.init.headers.Origin, undefined);
  assert.equal(exchange.init.headers.Referer, undefined);
  const body = JSON.parse(exchange.init.body);
  assert.deepEqual(body, {
    grant_type: "authorization_code",
    client_id: "voicelab-desktop",
    redirect_uri: pending.redirectUri,
    code: CALLBACK_CODE,
    code_verifier: pending.codeVerifier,
    installation_id: INSTALLATION_ID,
  });
  assert.equal(getPending(), null);
  assert.equal(getStoredSession().refreshToken, "refresh-token-abcdefghijklmnopqrstuvwxyz");

  const requestCountAfterExchange = calls.length;
  const duplicateStatus = await manager.handleCallback(loopbackCallback(pending));
  assert.equal(duplicateStatus.status, "authenticated");
  assert.equal(calls.length, requestCountAfterExchange);
});

test("transient exchange rejection preserves PKCE state for a bounded manual retry", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let exchanges = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    exchanges += 1;
    if (exchanges === 1) {
      return jsonResponse(
        429,
        {
          error: { code: "rate_limited", message: "Wait before retrying." },
          request_id: "req_exchange_rate_limited",
        },
        { "Retry-After": "4" }
      );
    }
    return jsonResponse(200, {
      access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
      refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
      session_id: "desktop-session-retried",
      user: { id: "user-retried", email: "retried@example.com" },
    });
  };

  await manager.startAuthorization();
  const callback = loopbackCallback(getPending());
  await assert.rejects(manager.handleCallback(callback), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.requestId, "req_exchange_rate_limited");
    assert.equal(error.retryAfterSeconds, 4);
    return true;
  });
  assert.equal(manager.getPublicStatus().status, "waiting-for-browser");
  assert.equal(getPending().callbackFingerprint, "");
  assert.notEqual(manager.callbackServer, null);

  const status = await manager.handleCallback(callback);
  assert.equal(status.status, "authenticated");
  assert.equal(getStoredSession().sessionId, "desktop-session-retried");
  assert.equal(exchanges, 2);
});

test("loopback listener receives the browser redirect in the creating process", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
        expires_in: 600,
      });
    }
    if (url.endsWith("/desktop/token")) {
      return jsonResponse(200, {
        access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
        expires_in: 900,
        refresh_expires_in: 3600,
        session_id: "desktop-session-loopback",
        user: { id: "user-loopback", email: "loopback@example.com" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await manager.startAuthorization();
  const response = await originalFetch(loopbackCallback(getPending()));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /VoiceLab sign-in complete/);
  assert.equal(manager.getPublicStatus().status, "authenticated");
  assert.equal(getStoredSession().sessionId, "desktop-session-loopback");
  assert.equal(getPending(), null);
});

test("loopback listener closes and destroys temporary state after its first invalid callback", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let exchanges = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    exchanges += 1;
    throw new Error("must not exchange an invalid callback");
  };

  await manager.startAuthorization();
  const callback = loopbackCallback(getPending(), { state: "x".repeat(43) });
  const response = await originalFetch(callback);

  assert.equal(response.status, 400);
  assert.equal(manager.callbackServer, null);
  assert.equal(getPending(), null);
  assert.equal(exchanges, 0);
  await assert.rejects(originalFetch(callback));
});

test("state mismatch is terminal and expired callbacks cannot exchange", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, expirePending, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let exchanges = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    exchanges += 1;
    return jsonResponse(500, {});
  };

  await manager.startAuthorization();
  await assert.rejects(
    manager.handleCallback(loopbackCallback(getPending(), { state: "x".repeat(43) })),
    (error) => error.code === "AUTH_STATE_MISMATCH"
  );
  assert.equal(manager.getPublicStatus().status, "error");
  assert.equal(manager.getPublicStatus().errorCode, "AUTH_STATE_MISMATCH");
  assert.equal(getPending(), null);
  assert.equal(exchanges, 0);

  await manager.startAuthorization();
  const expired = getPending();
  expirePending();
  const status = await manager.handleCallback(loopbackCallback(expired));
  assert.equal(status.status, "expired");
  assert.equal(exchanges, 0);
  assert.equal(getPending(), null);
});

test("duplicate callbacks exchange exactly once while the first exchange is active", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let resolveExchange;
  let exchanges = 0;
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    exchanges += 1;
    return new Promise((resolve) => {
      resolveExchange = () =>
        resolve(
          jsonResponse(200, {
            access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
            refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
            user: { id: "user-7", email: "desktop@example.com" },
          })
        );
    });
  };
  await manager.startAuthorization();
  const callback = loopbackCallback(getPending());

  const first = manager.handleCallback(callback);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicateStatus = await manager.handleCallback(callback);
  assert.equal(duplicateStatus.status, "exchanging");
  assert.equal(exchanges, 1);
  resolveExchange();
  assert.equal((await first).status, "authenticated");
});

test("callback parser accepts only one code and state parameter", () => {
  const { DesktopAuthManager } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  const state = "s".repeat(43);
  assert.deepEqual(
    manager._parseCallback(`voicelab://auth/callback?code=${CALLBACK_CODE}&state=${state}`),
    { code: CALLBACK_CODE, state }
  );
  for (const callback of [
    `voicelab://auth/callback?v=2&code=${CALLBACK_CODE}&state=${state}`,
    `voicelab://auth/callback?v=1&code=${CALLBACK_CODE}&state=${state}&state=${state}`,
    `voicelab://auth/callback?v=1&code=${CALLBACK_CODE}&state=${state}&access_token=secret`,
    `voicelab://auth/callback?code=legacy-code-abcdefghijklmnopqrstuvwxyz&state=${state}`,
    `voicelab://auth/callback?code=${CALLBACK_CODE}&state=${"short"}`,
    `voicelab://auth/callback?error=access_denied&state=${state}`,
    `voicelab://auth/callback?code=${CALLBACK_CODE}&state=${"s".repeat(257)}`,
  ]) {
    assert.throws(
      () => manager._parseCallback(callback),
      (error) => error.code === "AUTH_CALLBACK_INVALID"
    );
  }
});

test("restart discards loopback state and rotates the persisted refresh credential", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const existing = {
    kind: "desktop-go-v2",
    accessToken: "existing-access-token-abcdefghijklmnopqrstuvwxyz",
    accessExpiresAt: Date.now() + 10 * 60_000,
    refreshToken: "existing-refresh-token-abcdefghijklmnopqrstuvwxyz",
    refreshExpiresAt: Date.now() + 60 * 60_000,
    sessionId: "existing-session",
    user: { id: "existing-user", email: "existing@example.com" },
  };
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager(existing);
  const manager = managerFrom(DesktopAuthManager);
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    if (url.endsWith("/desktop/token")) {
      return jsonResponse(200, {
        access_token: "restarted-access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "restarted-refresh-token-abcdefghijklmnopqrstuvwxyz",
        session_id: "existing-session",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await manager.startAuthorization();
  assert.equal(calls.length, 1);
  assert.equal(getStoredSession().sessionId, "existing-session");
  assert.ok(getPending());

  const restarted = managerFrom(DesktopAuthManager);
  const status = await restarted.initialize();
  assert.equal(status.status, "authenticated");
  assert.equal(calls.length, 2);
  assert.equal(
    getStoredSession().refreshToken,
    "restarted-refresh-token-abcdefghijklmnopqrstuvwxyz"
  );
  assert.equal(getPending(), null);
});

test("canonicalizes Go user aliases before storing and publishing authentication", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    if (url.endsWith("/desktop/token")) {
      return jsonResponse(200, {
        access_token: "access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "refresh-token-abcdefghijklmnopqrstuvwxyz",
        user: {
          user_id: 73,
          username: "desktop@example.com",
          full_name: "Desktop Person",
          avatar_url: "https://cdn.voicelab.uz/avatar/user-73.png",
          access_token: "must-not-reach-renderer",
          refresh_token: "must-not-be-persisted-in-user",
          internal_role: "operator",
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await manager.startAuthorization();
  const status = await manager.handleCallback(loopbackCallback(getPending()));

  assert.equal(status.status, "authenticated");
  assert.deepEqual(status.user, {
    id: "73",
    email: "desktop@example.com",
    name: "Desktop Person",
    image: "https://cdn.voicelab.uz/avatar/user-73.png",
  });
  assert.deepEqual(getStoredSession().user, status.user);
  assert.deepEqual(Object.keys(getStoredSession().user).sort(), ["email", "id", "image", "name"]);
  assert.equal(
    calls.some((url) => url.endsWith("/api/v2/auth/me")),
    false
  );
});

test("rejects oversized identities and unsafe avatar URLs from auth responses", () => {
  const { DesktopAuthManager } = loadDesktopAuthManager();

  assert.equal(
    DesktopAuthManager.normalizedUser({
      user: { id: "u".repeat(257), email: "desktop@example.com" },
    }),
    null
  );
  assert.deepEqual(
    DesktopAuthManager.normalizedUser({
      user: {
        id: "user-safe",
        email: "desktop@example.com",
        name: `Visible\u202e Name ${"n".repeat(300)}`,
        image: "javascript:alert(1)",
        password: "must-not-cross-boundary",
      },
    }),
    {
      id: "user-safe",
      email: "desktop@example.com",
      name: `Visible Name ${"n".repeat(243)}`,
      image: null,
    }
  );
});

test("uses first and last name together when the auth response provides both", () => {
  const { DesktopAuthManager } = loadDesktopAuthManager();

  assert.deepEqual(
    DesktopAuthManager.normalizedUser({
      user: {
        id: "full-name-user",
        email: "full-name@example.com",
        name: "Ilyosjon",
        given_name: "Ilyosjon",
        family_name: "Tursunov",
      },
    }),
    {
      id: "full-name-user",
      email: "full-name@example.com",
      name: "Ilyosjon Tursunov",
      image: null,
    }
  );
});

test("logout prevents a late authorization exchange from restoring credentials", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const { DesktopAuthManager, getPending, getStoredSession } = loadDesktopAuthManager();
  const manager = managerFrom(DesktopAuthManager);
  let resolveExchange;
  global.fetch = async (url) => {
    if (url.endsWith("/authorizations")) {
      return jsonResponse(201, {
        authorization_request_id: REQUEST_ID,
        authorization_url: `https://voicelab.uz/app/sign-in?desktop_auth_id=${REQUEST_ID}`,
      });
    }
    if (url.endsWith("/desktop/token")) {
      return new Promise((resolve) => {
        resolveExchange = () =>
          resolve(
            jsonResponse(200, {
              access_token: "late-access-token-abcdefghijklmnopqrstuvwxyz",
              refresh_token: "late-refresh-token-abcdefghijklmnopqrstuvwxyz",
              user: { id: "late-user", email: "late@example.com" },
            })
          );
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await manager.startAuthorization();
  const exchange = manager.handleCallback(loopbackCallback(getPending()));
  await new Promise((resolve) => setImmediate(resolve));
  await manager.logout();
  resolveExchange();

  assert.equal((await exchange).status, "signed-out");
  assert.equal(getStoredSession(), null);
  assert.equal(manager.getPublicStatus().status, "signed-out");
});
