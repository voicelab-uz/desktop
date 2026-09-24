const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function quitHandler({ drain, shutdown = async () => {}, updating = false }) {
  const source = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const start = source.indexOf("  let isShuttingDown = false;");
  const end = source.indexOf("\n}\n\nfunction performSyncTeardown()", start);
  assert.ok(start > -1 && end > start);
  const calls = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: {
      on: (_event, callback) => {
        handler = callback;
      },
      exit: () => calls.push("exit"),
    },
    desktopAuthManager: {
      drainRefreshForShutdown: () => {
        calls.push("drain");
        return drain();
      },
    },
    updateManager: { isQuittingForUpdate: updating },
    databaseManager: { sealAtRest: () => calls.push("seal") },
    performSyncTeardown: () => calls.push("teardown"),
    sidecarRegistry: { shutdownAll: shutdown },
    debugLogger: { error() {} },
  });
  return { handler, calls, event: () => ({ preventDefault: () => calls.push("prevent") }) };
}

test("normal quit and repeated quit wait for token persistence before closing SQLite and exiting", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { handler, calls, event } = quitHandler({ drain: () => pending });
  handler(event());
  handler(event());
  await Promise.resolve();
  assert.deepEqual(calls, ["prevent", "drain", "teardown", "prevent"]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["prevent", "drain", "teardown", "prevent", "seal", "exit"]);
});

test("normal quit still seals and exits after bounded auth failure or sidecar rejection", async () => {
  const { handler, calls, event } = quitHandler({
    drain: async () => {
      throw new Error("authentication timed out");
    },
    shutdown: async () => {
      throw new Error("sidecar failure");
    },
  });
  handler(event());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["prevent", "drain", "teardown", "seal", "exit"]);
});

test("native updater quit is allowed after the updater has drained authentication", () => {
  const { handler, calls, event } = quitHandler({ updating: true, drain: async () => {} });
  handler(event());
  assert.deepEqual(calls, ["seal", "teardown"]);
});
