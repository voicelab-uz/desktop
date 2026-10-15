const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const helpersDir = path.resolve(__dirname, "../../src/helpers");
const appPath = path.resolve(__dirname, "../..");
const htmlPath = path.join(appPath, "src/dist/index.html");

function loadDesktop({ isPackaged, nodeEnv, rendererExists = true }) {
  const env = { VOICELAB_CHANNEL: "development" };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const loads = [];
  const modules = new Map();
  class BrowserWindow {
    webContents = { send() {}, on() {}, setWindowOpenHandler() {} };
    isDestroyed() {
      return false;
    }
    on() {}
    setContentProtection() {}
    setIgnoreMouseEvents() {}
    showInactive() {}
    async loadFile(filePath, options) {
      loads.push({ filePath, query: { ...options.query } });
    }
    async loadURL(url) {
      loads.push({ url });
    }
  }
  const electron = {
    app: { isPackaged, getAppPath: () => appPath },
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({}),
      getCursorScreenPoint: () => ({}),
      getDisplayNearestPoint: () => ({}),
    },
    systemPreferences: { isTrustedAccessibilityClient: () => false },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    const filename = path.join(helpersDir, `${name}.js`);
    vm.runInNewContext(
      fs.readFileSync(filename, "utf8"),
      {
        module,
        process: { env, platform: "darwin" },
        URL,
        URLSearchParams,
        setTimeout: () => 1,
        clearTimeout() {},
        require(id) {
          if (id === "electron") return electron;
          if (id === "fs") return { existsSync: () => rendererExists };
          if (id === "path" || id === "url") return require(id);
          if (id === "./devServerManager") return load("devServerManager");
          if (id === "./windowSecurity") return load("windowSecurity");
          if (id === "./windowConfig") {
            return {
              WindowPositionUtil: {
                getNotificationPosition: () => ({}),
                getAccessibilityDropPosition: () => ({}),
                setupAlwaysOnTop() {},
              },
            };
          }
          if (id.startsWith("./")) return {};
          throw new Error(`Unexpected dependency: ${id}`);
        },
      },
      { filename }
    );
    return module.exports;
  }
  const devServer = load("devServerManager");
  let serverWaits = 0;
  devServer.waitForDevServer = async () => {
    serverWaits += 1;
    return true;
  };
  const WindowManager = load("windowManager");
  const manager = Object.create(WindowManager.prototype);
  manager._windowLoadPromises = new WeakMap();
  manager._startAccessibilityDropPoll = () => {};
  return {
    devServer,
    manager,
    env,
    loads,
    BrowserWindow,
    security: load("windowSecurity"),
    serverWaits: () => serverWaits,
  };
}

async function openRendererWindows(desktop) {
  const { manager, BrowserWindow } = desktop;
  await manager.loadWindowContent(new BrowserWindow());
  await manager.loadWindowContent(new BrowserWindow(), true);
  await manager.loadWindowContent(new BrowserWindow(), false, true);
  await manager.ensureTranscriptionPreviewWindow();
  await manager.showMeetingNotification({});
  await manager.showAccessibilityDrop();
}

for (const nodeEnv of [undefined, "production", "development"]) {
  test(`packaged windows use bundled files with NODE_ENV=${nodeEnv}`, async () => {
    const desktop = loadDesktop({ isPackaged: true, nodeEnv });
    assert.equal(desktop.devServer.isDevelopment(), false);
    assert.equal(desktop.devServer.getAppUrl(), null);
    assert.equal(desktop.devServer.getAppFilePath().path, htmlPath);

    await openRendererWindows(desktop);
    assert.equal(desktop.serverWaits(), 0);
    assert.deepEqual(desktop.loads, [
      { filePath: htmlPath, query: {} },
      { filePath: htmlPath, query: { panel: "true" } },
      { filePath: htmlPath, query: { agent: "true" } },
      { filePath: htmlPath, query: { "transcription-preview": "true" } },
      { filePath: htmlPath, query: { "meeting-notification": "true" } },
      { filePath: htmlPath, query: { "accessibility-drop": "true" } },
    ]);
    assert.equal(desktop.security.isAllowedRendererUrl(pathToFileURL(htmlPath).href), true);
    assert.equal(desktop.security.isAllowedRendererUrl("http://localhost:5183/"), false);
  });
}

test("unpackaged development still loads every window from Vite", async () => {
  const desktop = loadDesktop({ isPackaged: false, nodeEnv: "development" });
  assert.equal(desktop.devServer.isDevelopment(), true);
  assert.equal(desktop.devServer.getAppFilePath(), null);
  await openRendererWindows(desktop);
  assert.equal(desktop.serverWaits(), 6);
  assert.deepEqual(
    desktop.loads.map(({ url }) => url),
    [
      "http://localhost:5183/",
      "http://localhost:5183/?panel=true",
      "http://localhost:5183/?agent=true",
      "http://localhost:5183/?transcription-preview=true",
      "http://localhost:5183/?meeting-notification=true",
      "http://localhost:5183/?accessibility-drop=true",
    ]
  );
  assert.equal(desktop.security.isAllowedRendererUrl("http://localhost:5183/"), true);
  assert.equal(desktop.security.isAllowedRendererUrl(pathToFileURL(htmlPath).href), false);
});

test("packaged renderer stays local after profile environment is loaded", () => {
  const desktop = loadDesktop({ isPackaged: true, nodeEnv: "production" });
  desktop.env.NODE_ENV = "development";
  assert.equal(desktop.devServer.getAppUrl(), null);
  assert.equal(desktop.devServer.getAppFilePath().path, htmlPath);
  assert.equal(desktop.security.isAllowedRendererUrl("http://localhost:5183/"), false);
});

test("missing packaged renderer reports its path without trying a dev server", async () => {
  const desktop = loadDesktop({
    isPackaged: true,
    nodeEnv: "development",
    rendererExists: false,
  });
  await assert.rejects(desktop.manager.loadWindowContent(new desktop.BrowserWindow()), {
    message: `HTML file not found: ${htmlPath}`,
  });
  assert.equal(desktop.serverWaits(), 0);
  assert.deepEqual(desktop.loads, []);
});
