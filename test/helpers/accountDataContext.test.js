const test = require("node:test");
const assert = require("node:assert/strict");
const { AccountDataContext } = require("../../src/helpers/accountDataContext");

function fixture() {
  let status = "authenticated";
  let accountId = "A";
  let sessionId = "session-A";
  const context = new AccountDataContext({
    getPublicStatus: () => ({ status }),
    getSessionMetadata: () => ({ accountId, sessionId }),
  });
  return {
    context,
    change(nextStatus, nextAccount, nextSession) {
      status = nextStatus;
      accountId = nextAccount;
      sessionId = nextSession;
      context.handleAuthStatus();
    },
  };
}

test("a same-account token refresh does not discard an in-flight history or STT result", () => {
  const { context, change } = fixture();
  const pendingResult = context.capture();
  change("authenticated", "A", "session-A");
  assert.doesNotThrow(pendingResult);
});

test("logout or account switching invalidates pending results, including A to B to A", () => {
  const { context, change } = fixture();
  const pendingResult = context.capture();
  change("signed-out", null, null);
  assert.throws(pendingResult, { code: "AUTH_ACCOUNT_CHANGED" });
  change("authenticated", "B", "session-B");
  change("authenticated", "A", "session-A");
  assert.throws(pendingResult, { code: "AUTH_ACCOUNT_CHANGED" });
  assert.doesNotThrow(context.capture());
});

test("a new session for the same account invalidates pending private data", () => {
  const { context, change } = fixture();
  const pendingResult = context.capture();
  change("authenticated", "A", "replacement-session");
  assert.throws(pendingResult, { code: "AUTH_ACCOUNT_CHANGED" });
});
