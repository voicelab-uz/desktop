const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function loadUpdater() {
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => ({});
  autoUpdater.downloadUpdate = async () => {};
  autoUpdater.quitAndInstall = () => {};
  const nativeUpdater = new EventEmitter();
  const notifications = [];
  const reminders = [];
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  class Notification extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(options) {
      super();
      this.options = options;
      notifications.push(this);
    }
    show() {}
    close() {
      this.emit("close");
    }
  }
  const auth = {
    suspended: false,
    resumed: 0,
    async drainRefreshForShutdown() {
      this.suspended = true;
    },
    resumeBackgroundRefresh() {
      this.suspended = false;
      this.resumed += 1;
    },
  };
  const context = {
    module: { exports: {} },
    console: { log() {}, warn() {}, info() {}, error() {} },
    process: { env: { NODE_ENV: "production" }, platform: "darwin", arch: "arm64" },
    setTimeout: setTimer,
    clearTimeout: (id) => timers.delete(id),
    setInterval: setTimer,
    clearInterval: (id) => timers.delete(id),
    require(id) {
      if (id === "electron")
        return {
          app: { isPackaged: true, getVersion: () => "1.2.1" },
          Notification,
          autoUpdater: nativeUpdater,
        };
      if (id === "electron-updater") return { autoUpdater };
      if (id.endsWith("i18nMain")) return { i18nMain: { t: (key) => key } };
      if (id.endsWith("releaseNotes")) return { publicUpdateInfo: (info) => info };
      if (id.endsWith("updateFeedConfig")) return { resolveUpdateFeed: () => ({}) };
      if (id.endsWith("versionComparison")) return require("../../src/helpers/versionComparison");
      if (id.endsWith("updateReminderStore"))
        return {
          shouldRemindAboutUpdate: (version) => !reminders.includes(version),
          recordUpdateReminder: (version) => reminders.push(version),
        };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, "../../src/updater.js"), "utf8"),
    context
  );
  const manager = new context.module.exports();
  manager.setAuthManager(auth);
  return { manager, autoUpdater, nativeUpdater, auth, notifications, reminders, timers };
}

test("architecture channel configuration never permits downgrades", () => {
  const { autoUpdater } = loadUpdater();
  assert.equal(autoUpdater.channel, "latest-arm64");
  assert.equal(autoUpdater.allowDowngrade, false);
});

test("rechecks preserve the actual downloaded version and its restart notification", async () => {
  const { manager, autoUpdater, notifications } = loadUpdater();
  autoUpdater.emit("update-available", { version: "1.2.2" });
  autoUpdater.emit("update-downloaded", { version: "1.2.2" });
  const readyNotification = manager.nativeUpdateNotification;
  autoUpdater.emit("update-available", { version: "1.2.3" });
  assert.equal((await manager.getUpdateInfo()).version, "1.2.2");
  assert.equal(manager.availableUpdateInfo.version, "1.2.3");
  assert.equal(manager.nativeUpdateNotification, readyNotification);
  assert.equal(notifications.length, 2);
  autoUpdater.emit("update-not-available", { version: "1.2.1" });
  assert.equal((await manager.getUpdateStatus()).info.version, "1.2.2");
  assert.equal(manager.updateDownloaded, true);
});

test("an older availability notification action installs an already downloaded update", async () => {
  const { manager, autoUpdater, notifications } = loadUpdater();
  autoUpdater.emit("update-available", { version: "1.2.2" });
  const oldNotification = notifications[0];
  autoUpdater.emit("update-downloaded", { version: "1.2.2" });
  let installed = 0;
  manager.installUpdate = async () => {
    installed += 1;
    return { success: true };
  };
  manager.downloadUpdate = async () => {
    assert.fail("must not redownload");
  };
  oldNotification.emit("action", {}, 0);
  await Promise.resolve();
  assert.equal(installed, 1);
});

test("failed notification delivery does not consume the reminder cooldown", () => {
  const { manager, autoUpdater, notifications, reminders } = loadUpdater();
  autoUpdater.emit("update-available", { version: "1.2.2" });
  notifications[0].emit("failed", {}, "delivery denied");
  assert.deepEqual(reminders, []);
  autoUpdater.emit("update-available", { version: "1.2.2" });
  assert.equal(notifications.length, 2);
  notifications[1].emit("show");
  notifications[1].emit("show");
  assert.deepEqual(reminders, ["1.2.2"]);
  autoUpdater.emit("update-available", { version: "1.2.2" });
  assert.equal(notifications.length, 2);
  manager.cleanup();
});

for (const mode of ["event", "throw", "asynchronous event"]) {
  test(`installer ${mode} failure resumes auth and permits a retry`, async () => {
    const { manager, autoUpdater, auth } = loadUpdater();
    autoUpdater.emit("update-downloaded", { version: "1.2.2" });
    autoUpdater.quitAndInstall = () => {
      if (mode === "throw") throw new Error("permission denied");
      if (mode === "event") autoUpdater.emit("error", new Error("permission denied"));
    };
    if (mode === "throw") {
      await assert.rejects(manager.installUpdate(), /permission denied/);
    } else {
      const result = await manager.installUpdate();
      if (mode === "event") assert.equal(result.success, false);
      else autoUpdater.emit("error", new Error("permission denied"));
    }
    assert.equal(manager.isInstalling, false);
    assert.equal(auth.suspended, false);
    assert.equal(auth.resumed, 1);
    autoUpdater.quitAndInstall = () => {};
    assert.equal((await manager.installUpdate()).success, true);
    assert.equal(manager.isInstalling, true);
  });
}

test("installation waits for refresh persistence and blocks a concurrent attempt", async () => {
  const { manager, autoUpdater, auth } = loadUpdater();
  autoUpdater.emit("update-downloaded", { version: "1.2.2" });
  let finishRefresh;
  auth.drainRefreshForShutdown = () =>
    new Promise((resolve) => {
      finishRefresh = resolve;
    });
  let installed = false;
  autoUpdater.quitAndInstall = () => {
    installed = true;
  };
  const pending = manager.installUpdate();
  assert.equal((await manager.installUpdate()).success, false);
  assert.equal(installed, false);
  finishRefresh();
  assert.equal((await pending).success, true);
  assert.equal(installed, true);
});

test("retrying while a failed install still drains auth cannot launch two installers", async () => {
  const { manager, autoUpdater, auth } = loadUpdater();
  autoUpdater.emit("update-downloaded", { version: "1.2.2" });
  let finishRefresh;
  const refresh = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  auth.drainRefreshForShutdown = () => refresh;
  let installed = 0;
  autoUpdater.quitAndInstall = () => {
    installed += 1;
  };
  const oldAttempt = manager.installUpdate();
  autoUpdater.emit("error", new Error("installer interrupted"));
  const retry = manager.installUpdate();
  finishRefresh();
  assert.equal((await oldAttempt).success, false);
  assert.equal((await retry).success, true);
  assert.equal(installed, 1);
  assert.equal(manager.isInstalling, true);
});

test("status hydration includes in-flight progress and pending installer state", async () => {
  const { manager, autoUpdater } = loadUpdater();
  autoUpdater.emit("update-available", { version: "1.2.2" });
  let finishDownload;
  autoUpdater.downloadUpdate = () =>
    new Promise((resolve) => {
      finishDownload = resolve;
    });
  const download = manager.downloadUpdate();
  autoUpdater.emit("download-progress", { percent: 42, transferred: 42, total: 100 });
  const status = await manager.getUpdateStatus();
  assert.equal(status.isDownloading, true);
  assert.equal(status.downloadProgress, 42);
  assert.equal(status.info.version, "1.2.2");
  autoUpdater.emit("update-downloaded", { version: "1.2.2" });
  finishDownload();
  await download;
  await manager.installUpdate();
  assert.equal((await manager.getUpdateStatus()).isInstalling, true);
});

test("offline checks retry at bounded intervals and stop after cleanup", async () => {
  const { manager, autoUpdater, timers } = loadUpdater();
  let attempts = 0;
  autoUpdater.checkForUpdates = async () => {
    attempts += 1;
    throw new Error("offline");
  };
  await manager.checkForUpdatesInBackground();
  for (const expectedDelay of [30_000, 120_000, 300_000]) {
    const [id, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, expectedDelay);
    timers.delete(id);
    timer.callback();
    await new Promise(setImmediate);
  }
  assert.equal(attempts, 4);
  assert.equal(timers.size, 0);
  autoUpdater.checkForUpdates = async () => ({});
  await manager.checkForUpdatesInBackground();
  assert.equal(manager.updateRetryAttempt, 0);
  manager.checkForUpdatesOnStartup();
  assert.equal(timers.size, 2);
  manager.cleanup();
  assert.equal(timers.size, 0);
  await manager.checkForUpdatesInBackground();
  assert.equal(attempts, 4);
});
