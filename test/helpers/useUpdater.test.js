const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function loadHook(apiOverrides = {}) {
  const callbacks = {};
  const status = {
    updateAvailable: true,
    updateDownloaded: false,
    isDevelopment: false,
    info: { version: "1.2.2" },
    isDownloading: false,
    isInstalling: false,
    downloadProgress: 0,
  };
  const api = {
    getUpdateStatus: async () => status,
    downloadUpdate: async () => ({ success: true, message: "started" }),
    installUpdate: async () => ({ success: true, message: "started" }),
    ...apiOverrides,
  };
  for (const name of [
    "UpdateAvailable",
    "UpdateNotAvailable",
    "UpdateDownloaded",
    "UpdateDownloadProgress",
    "UpdateError",
  ]) {
    api[`on${name}`] = (callback) => {
      callbacks[name] = callback;
      return () => {
        delete callbacks[name];
      };
    };
  }
  let mounted = false;
  const timers = new Map();
  let timerId = 0;
  const context = {
    exports: {},
    window: { electronAPI: api },
    console: { error() {} },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    require(id) {
      assert.equal(id, "react");
      return {
        useState: (value) => [value, () => {}],
        useCallback: (callback) => callback,
        useEffect: (callback) => {
          if (!mounted) {
            mounted = true;
            callback();
          }
        },
      };
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/hooks/useUpdater.ts"), "utf8");
  const compiled = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(compiled.outputText, context);
  const render = () => context.exports.useUpdater();
  render();
  return { render, callbacks, status, api, timers };
}

test("reopened updater hydrates busy state and actual pending version", async () => {
  const hook = loadHook();
  Object.assign(hook.status, { isDownloading: true, downloadProgress: 62 });
  await new Promise(setImmediate);
  assert.equal(hook.render().isDownloading, true);
  assert.equal(hook.render().downloadProgress, 62);
  assert.equal(hook.render().info.version, "1.2.2");
  hook.callbacks.UpdateDownloaded({}, { version: "1.2.2" });
  hook.callbacks.UpdateAvailable({}, { version: "1.2.3" });
  assert.equal(hook.render().info.version, "1.2.2");
});

test("a partial event during initial hydration cannot hide a pending installation", async () => {
  let reply;
  let requests = 0;
  const pending = {
    updateAvailable: false,
    updateDownloaded: true,
    isDevelopment: false,
    info: { version: "1.2.2" },
    downloadProgress: 100,
  };
  const hook = loadHook({
    getUpdateStatus: () => {
      requests += 1;
      return requests === 1
        ? new Promise((resolve) => {
            reply = resolve;
          })
        : Promise.resolve(pending);
    },
  });
  hook.callbacks.UpdateNotAvailable();
  reply(pending);
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(hook.render().status.updateDownloaded, true);
  assert.equal(hook.render().info.version, "1.2.2");
  assert.equal(hook.render().downloadProgress, 100);
});

test("sustained hydration races schedule one trailing refresh instead of looping", async () => {
  let reply;
  let requests = 0;
  const hook = loadHook({
    getUpdateStatus: () => {
      requests += 1;
      return new Promise((resolve) => {
        reply = resolve;
      });
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    hook.callbacks.UpdateDownloadProgress({}, { percent: attempt + 1 });
    reply(hook.status);
    await new Promise(setImmediate);
  }
  assert.equal(requests, 3);
  assert.equal(hook.timers.size, 1);
  const [id, timer] = [...hook.timers.entries()][0];
  assert.equal(timer.delay, 100);
  hook.timers.delete(id);
  timer.callback();
  reply({ ...hook.status, isDownloading: true, downloadProgress: 42 });
  await new Promise(setImmediate);
  assert.equal(requests, 4);
  assert.equal(hook.render().downloadProgress, 42);
  assert.equal(hook.timers.size, 0);
});

test("a late initial snapshot cannot erase a just-downloaded update", async () => {
  let reply;
  const hook = loadHook({
    getUpdateStatus: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  });
  hook.callbacks.UpdateDownloaded({}, { version: "1.2.2" });
  reply({ updateAvailable: false, updateDownloaded: false, isDevelopment: false });
  await new Promise(setImmediate);
  assert.equal(hook.render().status.updateDownloaded, true);
  assert.equal(hook.render().info.version, "1.2.2");
  reply({ ...hook.status, updateDownloaded: true });
  await new Promise(setImmediate);
});

test("rejected download and install results clear the renderer busy state", async () => {
  const hook = loadHook({
    downloadUpdate: async () => ({ success: false, message: "No newer update is available" }),
    installUpdate: async () => ({ success: false, message: "Installation failed" }),
  });
  await new Promise(setImmediate);
  await assert.rejects(hook.render().downloadUpdate(), /No newer update/);
  assert.equal(hook.render().isDownloading, false);
  hook.callbacks.UpdateDownloaded({}, { version: "1.2.2" });
  await assert.rejects(hook.render().installUpdate(), /Installation failed/);
  assert.equal(hook.render().isInstalling, false);
});

test("an already-downloaded response restores install state instead of a stuck spinner", async () => {
  const hook = loadHook();
  await new Promise(setImmediate);
  hook.api.downloadUpdate = async () => {
    Object.assign(hook.status, { updateDownloaded: true, downloadProgress: 100 });
    return { success: true, message: "Already downloaded" };
  };
  await hook.render().downloadUpdate();
  assert.equal(hook.render().isDownloading, false);
  assert.equal(hook.render().status.updateDownloaded, true);
});

test("an old failed install response cannot clear a retry's busy state", async () => {
  const replies = [];
  const hook = loadHook({
    installUpdate: () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  });
  await new Promise(setImmediate);
  hook.callbacks.UpdateDownloaded({}, { version: "1.2.2" });
  const first = hook.render().installUpdate();
  hook.callbacks.UpdateError({}, new Error("Install failed"));
  const retry = hook.render().installUpdate();
  replies[0]({ success: false, message: "Old install failed" });
  await assert.rejects(first, /Old install failed/);
  assert.equal(hook.render().isInstalling, true);
  replies[1]({ success: true, message: "Installing" });
  await retry;
});
