// KDE/GNOME Wayland: self-relaunch with --ozone-platform=x11 to force XWayland.
// Chromium picks the display backend before JS runs, so appendSwitch is too late.
if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE === "wayland" &&
  !process.argv.includes("--ozone-platform=x11")
) {
  const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
  if (desktop.includes("kde") || /gnome|ubuntu|unity|cosmic/.test(desktop)) {
    const { spawn } = require("child_process");
    spawn(process.execPath, [...process.argv.slice(1), "--ozone-platform=x11"], {
      stdio: "inherit",
      detached: true,
    }).unref();
    process.exit(0);
  }
}

const {
  app,
  desktopCapturer,
  globalShortcut,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  systemPreferences,
  webContents,
} = require("electron");

// Chromium otherwise creates and reads a "VoiceLab Safe Storage" item in the
// macOS Keychain even though desktop authentication never uses browser-cookie
// sessions. Keep Chromium's profile storage local so app launch cannot trigger
// a Keychain password prompt. Dedicated desktop credentials remain protected
// by the application's authenticated local storage layer.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

const path = require("path");
const tls = require("tls");
// Development may load local configuration. Packaged builds never load or ship
// a project-level .env; user-provided credentials live in the encrypted user profile.
if (!app.isPackaged) {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
}

// Extend Node's TLS trust with the OS store so ws and https.get see corporate
// CAs that Chromium already trusts.
try {
  const currentCAs = tls.getCACertificates();
  const systemCAs = tls.getCACertificates("system");
  if (systemCAs?.length) {
    tls.setDefaultCACertificates([...currentCAs, ...systemCAs]);
  }
} catch (err) {
  require("./src/helpers/debugLogger").warn("System CA merge failed; using existing CA list", {
    error: err?.message,
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "voicelab-dev",
  staging: "voicelab-staging",
  production: "voicelab",
};
const BASE_WINDOWS_APP_ID = "uz.voicelab.desktop";
const CHANNEL_ENV = "VOICELAB_CHANNEL";
const LEGACY_CHANNEL_ENV = "OPENWHISPR_CHANNEL";

function isElectronBinaryExec() {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
}

function inferDefaultChannel() {
  if (process.env.NODE_ENV === "development" || process.defaultApp || isElectronBinaryExec()) {
    return "development";
  }
  return "production";
}

function resolveAppChannel() {
  if (app.isPackaged) {
    try {
      const packagedMetadata = require(path.join(__dirname, "package.json"));
      const packagedChannel = String(packagedMetadata.voicelabChannel || "")
        .trim()
        .toLowerCase();
      if (VALID_CHANNELS.has(packagedChannel)) {
        return packagedChannel;
      }
    } catch {}
    return "production";
  }

  const rawChannel = (process.env[CHANNEL_ENV] || process.env[LEGACY_CHANNEL_ENV] || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();
process.env[CHANNEL_ENV] = APP_CHANNEL;

function configureChannelUserDataPath() {
  const fs = require("fs");
  const appDataPath = app.getPath("appData");
  const defaultPath = app.getPath("userData");
  const channelSuffix = APP_CHANNEL === "production" ? "" : `-${APP_CHANNEL}`;
  const canonicalPath = path.join(appDataPath, `VoiceLab${channelSuffix}`);
  const legacyPaths = [
    ...(APP_CHANNEL === "production" ? [defaultPath] : []),
    path.join(appDataPath, `OpenWhispr${channelSuffix}`),
  ].filter((candidate, index, candidates) => {
    return candidate !== canonicalPath && candidates.indexOf(candidate) === index;
  });

  if (!fs.existsSync(canonicalPath)) {
    const legacyPath = legacyPaths.find((candidate) => fs.existsSync(candidate));
    if (legacyPath) {
      try {
        fs.renameSync(legacyPath, canonicalPath);
      } catch (error) {
        // Keep using the old profile if an atomic migration is unavailable.
        // This preserves auth tokens, encrypted settings, and local data.
        console.warn(`[Startup] Could not migrate user data to VoiceLab: ${error.message}`);
        app.setPath("userData", legacyPath);
        return;
      }
    }
  }

  app.setPath("userData", canonicalPath);
}

configureChannelUserDataPath();

// Load userData .env (contains DICTATION_KEY and optional BYOK provider keys) early —
// before hotkey registration, which needs DICTATION_KEY before the renderer loads.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: true,
});

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("gtk-version", "3");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Wayland: packaged builds use the wrapper script (scripts/afterPack.js) to
// force --ozone-platform=x11 before Electron starts. appendSwitch below is a
// best-effort fallback for unpackaged dev mode (may not take effect on E39+).
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
}

// Set desktop filename so Wayland compositors can match windows to the .desktop entry.
// This allows XDG portals (e.g. PipeWire) to persist permissions across sessions.
if (process.platform === "linux") {
  app.setDesktopName("voicelab.desktop");
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production" ? BASE_WINDOWS_APP_ID : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

function getOAuthProtocol() {
  return (
    DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production
  );
}

const OAUTH_PROTOCOL = getOAuthProtocol();
const { resolveDesktopRuntimeAuthConfig } = require("./src/helpers/desktopRuntimeAuthConfig");
const DESKTOP_AUTH_CONFIG = resolveDesktopRuntimeAuthConfig({
  channel: APP_CHANNEL,
  isPackaged: app.isPackaged,
  scheme: OAUTH_PROTOCOL,
  env: process.env,
});

const initialProtocolUrls = process.argv.filter((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`));

function shouldRegisterProtocolWithAppArg() {
  return Boolean(process.defaultApp) || isElectronBinaryExec();
}

function getDefaultHtmlHandler() {
  try {
    const { execFileSync } = require("child_process");
    return (
      execFileSync("xdg-mime", ["query", "default", "text/html"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function restoreHtmlHandlerIfChanged(original) {
  try {
    const { execFileSync } = require("child_process");
    const current = execFileSync("xdg-mime", ["query", "default", "text/html"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (current && current !== original) {
      execFileSync("xdg-mime", ["default", original, "text/html"], { timeout: 3000 });
    }
  } catch {
    // xdg-mime unavailable or failed
  }
}

// True source of truth for whether the VoiceLab OAuth scheme resolves on Linux — the same
// MIME database xdg-open consults. Returns true for deb/rpm/flatpak/AUR installs
// (scheme registered via the packaged .desktop MimeType) and false for AppImage/
// tar.gz runs where it genuinely isn't registered, so we never enable a dead-end
// OAuth flow. Used to recover from setAsDefaultProtocolClient's KDE false negative.
function isOAuthSchemeRegistered() {
  if (process.platform !== "linux") return false;
  try {
    const { execFileSync } = require("child_process");
    const handler = execFileSync(
      "xdg-mime",
      ["query", "default", `x-scheme-handler/${OAUTH_PROTOCOL}`],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return handler.length > 0;
  } catch {
    return false;
  }
}

// Register custom protocol for OAuth callbacks.
// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function registerVoiceLabProtocol() {
  const protocol = OAUTH_PROTOCOL;
  const htmlHandler = process.platform === "linux" ? getDefaultHtmlHandler() : null;

  let result;
  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    result = app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  } else {
    result = app.setAsDefaultProtocolClient(protocol);
  }

  if (htmlHandler) {
    restoreHtmlHandlerIfChanged(htmlHandler);
  }

  return result;
}

// setAsDefaultProtocolClient returns a false negative on KDE/Wayland, so on Linux
// fall back to probing the system MIME database for an actual handler. This keeps
// OAuth enabled where the callback can resolve (deb/rpm/flatpak/AUR) and correctly
// gated where it can't (AppImage/tar.gz with no scheme registration).
const protocolRegistered = registerVoiceLabProtocol() || isOAuthSchemeRegistered();
if (!protocolRegistered) {
  console.warn(`[Auth] Failed to register ${OAUTH_PROTOCOL}:// protocol handler`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "VoiceLab") {
  app.setName("VoiceLab");
}

// Add global error handling for uncaught exceptions
function errorSummary(error) {
  return {
    name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : undefined,
  };
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", errorSummary(error));
  // Don't exit the process for EPIPE errors as they're harmless
  if (error.code === "EPIPE") {
    return;
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", errorSummary(reason));
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const TrayManager = require("./src/helpers/tray");
const DesktopAuthManager = require("./src/helpers/desktopAuthManager");
const { DisplayMediaGrantManager } = require("./src/helpers/displayMediaGrant");
const { isAllowedRendererUrl } = require("./src/helpers/windowSecurity");
const VoiceLabApiClient = require("./src/helpers/voiceLabApiClient");
const dockManager = require("./src/helpers/dockManager");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const CliBridge = require("./src/helpers/cliBridge");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const WindowsKeyManager = require("./src/helpers/windowsKeyManager");
const LinuxKeyManager = require("./src/helpers/linuxKeyManager");
const TextEditMonitor = require("./src/helpers/textEditMonitor");
const GoogleCalendarManager = require("./src/helpers/googleCalendarManager");
const MeetingProcessDetector = require("./src/helpers/meetingProcessDetector");
const AudioActivityDetector = require("./src/helpers/audioActivityDetector");
const AudioTapManager = require("./src/helpers/audioTapManager");
const LinuxPortalAudioManager = require("./src/helpers/linuxPortalAudioManager");
const WindowsLoopbackAudioManager = require("./src/helpers/windowsLoopbackAudioManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { assertTrustedIpcSender } = require("./src/helpers/ipcSecurity");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const { ensureYdotool } = require("./src/helpers/ensureYdotool");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let diarizationManager = null;
let trayManager = null;
let desktopAuthManager = null;
let displayMediaGrantManager = null;
let voiceLabApiClient = null;
let updateManager = null;
let globeKeyManager = null;
let windowsKeyManager = null;
let linuxKeyManager = null;

function onTrustedIpc(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event, channel, windowManager);
      listener(event, ...args);
    } catch {
      console.warn(`Rejected IPC event: ${channel}`);
    }
  });
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, channel, windowManager);
    return handler(event, ...args);
  });
}

function isTrustedAppWebContents(contents) {
  if (!contents || contents.isDestroyed()) return false;
  const senderWindow = BrowserWindow.fromWebContents(contents);
  const knownWindows = [
    windowManager?.mainWindow,
    windowManager?.controlPanelWindow,
    windowManager?.agentWindow,
    windowManager?.notificationWindow,
    windowManager?.transcriptionPreviewWindow,
  ].filter(Boolean);
  return (
    Boolean(senderWindow && knownWindows.includes(senderWindow)) &&
    isAllowedRendererUrl(contents.mainFrame?.url || contents.getURL())
  );
}

function installSessionPermissionPolicy(targetSession) {
  targetSession.setPermissionCheckHandler((contents, permission, _origin, details = {}) => {
    return (
      permission === "media" && isTrustedAppWebContents(contents) && details.mediaType !== "video"
    );
  });
  targetSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
    const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(
      permission === "media" &&
        isTrustedAppWebContents(contents) &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === "audio")
    );
  });
}
let textEditMonitor = null;
let googleCalendarManager = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let linuxPortalAudioManager = null;
let windowsLoopbackAudioManager = null;
let meetingAecManager = null;
let ipcHandlers = null;
let cliBridge = null;
let globeKeyAlertShown = false;
let pendingNoteCloudId = null;
let pendingNoteRetryTimer = null;
let pendingNoteRetryCount = 0;

let protocolRouterReady = false;
const pendingProtocolUrls = [];

function protocolRouteError(code) {
  const error = new Error("Desktop protocol URL rejected");
  error.code = code;
  return error;
}

function parseProtocolRoute(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw protocolRouteError("DESKTOP_PROTOCOL_INVALID");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw protocolRouteError("DESKTOP_PROTOCOL_INVALID");
  }

  if (
    url.protocol !== `${OAUTH_PROTOCOL}:` ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw protocolRouteError("DESKTOP_PROTOCOL_INVALID");
  }

  if (url.hostname === "auth" && url.pathname === "/callback") {
    return { kind: "auth", value: url.toString() };
  }

  if (value === `${OAUTH_PROTOCOL}://billing-complete`) {
    return { kind: "billing", value };
  }

  const singlePathPart = url.pathname.match(/^\/([^/]+)\/?$/)?.[1] || "";
  if (url.hostname === "notes" && singlePathPart && !url.search) {
    const cloudId = decodeURIComponent(singlePathPart);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cloudId)) {
      return { kind: "note", value: url.toString(), payload: cloudId };
    }
  }

  if (url.hostname === "invitations" && singlePathPart && !url.search) {
    const invitationToken = decodeURIComponent(singlePathPart);
    if (/^[A-Za-z0-9._~-]{1,1024}$/.test(invitationToken)) {
      return { kind: "invitation", value: url.toString(), payload: invitationToken };
    }
  }

  throw protocolRouteError("DESKTOP_PROTOCOL_ROUTE_REJECTED");
}

async function dispatchProtocolRoute(route) {
  if (route.kind === "auth") {
    await handleOAuthDeepLink(route.value);
    return;
  }
  if (route.kind === "billing") {
    await handleBillingCompleteDeepLink();
    return;
  }
  if (route.kind === "note") {
    await handleNoteDeepLink(route.payload);
    return;
  }
  if (route.kind === "invitation") {
    handleInvitationDeepLink(route.payload);
    return;
  }
  throw protocolRouteError("DESKTOP_PROTOCOL_ROUTE_REJECTED");
}

function notifyProtocolFailure(error) {
  const errorCode =
    typeof error?.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)
      ? error.code
      : "DESKTOP_PROTOCOL_FAILED";
  console.warn("[Protocol] Deep link rejected", { errorCode });
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("desktop-protocol-error", { errorCode });
  }
}

async function safelyAcceptProtocolUrl(url) {
  try {
    await acceptProtocolUrl(url);
  } catch (error) {
    notifyProtocolFailure(error);
  }
}

async function acceptProtocolUrl(url) {
  const route = parseProtocolRoute(url);

  if (!protocolRouterReady) {
    if (!pendingProtocolUrls.includes(route.value) && pendingProtocolUrls.length < 16) {
      pendingProtocolUrls.push(route.value);
    }
    return;
  }

  await dispatchProtocolRoute(route);
}

async function flushPendingProtocolUrls() {
  const queued = pendingProtocolUrls.splice(0);
  for (const url of queued) {
    await safelyAcceptProtocolUrl(url);
  }
}

// Set up PATH for production builds to find bundled audio and utility tools.
function setupProductionPath() {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Phase 1: Initialize managers + IPC handlers before window content loads
// Best-effort cleanup of the orphaned portal restore-token file older builds wrote. See PR #904.
const LINUX_RESTORE_TOKEN_FILENAME = ".linux-system-audio-restore-token.json";

function cleanupOrphanedLinuxRestoreToken() {
  if (process.platform !== "linux") return;
  try {
    const fs = require("fs");
    fs.unlinkSync(path.join(app.getPath("userData"), LINUX_RESTORE_TOKEN_FILENAME));
  } catch {}
}

async function initializeCoreManagers() {
  setupProductionPath();

  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  const uiLanguage = environmentManager.getUiLanguage();
  process.env.UI_LANGUAGE = uiLanguage;
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  const appVersion = require("./package.json").version;
  desktopAuthManager = new DesktopAuthManager({
    channel: APP_CHANNEL,
    scheme: DESKTOP_AUTH_CONFIG.scheme,
    appVersion,
    apiBaseUrl: DESKTOP_AUTH_CONFIG.apiBaseUrl,
    authWebBaseUrl: DESKTOP_AUTH_CONFIG.authWebBaseUrl,
    authorizationOrigins: DESKTOP_AUTH_CONFIG.authorizationOrigins,
    // A registered app link brings VoiceLab to the foreground after browser approval.
    // Keep loopback as the fallback where an OS handler cannot be registered.
    useCustomProtocol: protocolRegistered,
  });
  await desktopAuthManager.initialize();
  displayMediaGrantManager = new DisplayMediaGrantManager({
    isAllowedUrl: isAllowedRendererUrl,
  });
  voiceLabApiClient = new VoiceLabApiClient({
    authManager: desktopAuthManager,
    apiBaseUrl: DESKTOP_AUTH_CONFIG.apiBaseUrl,
    appVersion,
    channel: APP_CHANNEL,
    billingOrigin: DESKTOP_AUTH_CONFIG.billingOrigin,
  });
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  clipboardManager = new ClipboardManager();
  googleCalendarManager = new GoogleCalendarManager(databaseManager, windowManager);
  meetingDetectionEngine = new MeetingDetectionEngine(
    googleCalendarManager,
    new MeetingProcessDetector(),
    new AudioActivityDetector(),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  googleCalendarManager.meetingDetectionEngine = meetingDetectionEngine;
  updateManager = new UpdateManager();
  updateManager.setWindowManager(windowManager);
  updateManager.setAuthManager(desktopAuthManager);
  windowsKeyManager = new WindowsKeyManager();
  linuxKeyManager = new LinuxKeyManager();
  textEditMonitor = new TextEditMonitor();
  textEditMonitor.rememberOwnPid(process.pid);
  audioTapManager = new AudioTapManager();
  linuxPortalAudioManager = new LinuxPortalAudioManager();
  windowsLoopbackAudioManager = new WindowsLoopbackAudioManager();
  // Warm the capability cache off the hot path so the first meeting start
  // doesn't pay the probe spawn. No-ops on non-Windows.
  windowsLoopbackAudioManager.getCapability().catch(() => {});
  cleanupOrphanedLinuxRestoreToken();
  meetingAecManager = new MeetingAecManager();
  windowManager.textEditMonitor = textEditMonitor;
  windowManager.windowsKeyManager = windowsKeyManager;
  windowManager.linuxKeyManager = linuxKeyManager;

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    diarizationManager,
    windowManager,
    updateManager,
    windowsKeyManager,
    linuxKeyManager,
    textEditMonitor,
    googleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    linuxPortalAudioManager,
    windowsLoopbackAudioManager,
    meetingAecManager,
    getTrayManager: () => trayManager,
    desktopAuthManager,
    displayMediaGrantManager,
    voiceLabApiClient,
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });
}

function registerSidecars() {
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient");
  sidecarRegistry.register("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  ensureYdotool().catch((err) => {
    require("./src/helpers/debugLogger").warn(
      "ydotool setup error",
      { error: err?.message },
      "clipboard"
    );
  });
  clipboardManager.preWarmAccessibility();
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager();

  if (process.platform === "darwin") {
    globeKeyManager.on("error", (error) => {
      if (globeKeyAlertShown) {
        return;
      }
      globeKeyAlertShown = true;

      const detailLines = [
        error?.message || i18nMain.t("startup.globeHotkey.details.unknown"),
        i18nMain.t("startup.globeHotkey.details.fallback"),
      ];

      if (process.env.NODE_ENV === "development") {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.devHint"));
      } else {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.reinstallHint"));
      }

      dialog.showMessageBox({
        type: "warning",
        title: i18nMain.t("startup.globeHotkey.title"),
        message: i18nMain.t("startup.globeHotkey.message"),
        detail: detailLines.join("\n\n"),
      });
    });
  }

  googleCalendarManager.start();
  meetingDetectionEngine.start();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  void safelyAcceptProtocolUrl(url);
});

function clearPendingNoteDeepLink() {
  clearTimeout(pendingNoteRetryTimer);
  pendingNoteRetryTimer = null;
  pendingNoteCloudId = null;
  pendingNoteRetryCount = 0;
}

async function flushPendingNoteDeepLink() {
  if (!pendingNoteCloudId || !windowManager || !databaseManager) return;

  try {
    // Surface the panel on the first attempt only; retries just poll the
    // database so they can't repeatedly steal focus.
    if (pendingNoteRetryCount === 0) {
      await windowManager.createControlPanelWindow();
    }

    const note = databaseManager.getNoteByCloudId(pendingNoteCloudId);
    if (!note) {
      // Cloud sync may still be hydrating during a cold launch. Retry briefly so
      // the handoff can resolve a note pulled after the protocol event arrived.
      pendingNoteRetryCount += 1;
      if (pendingNoteRetryCount <= 10) {
        clearTimeout(pendingNoteRetryTimer);
        pendingNoteRetryTimer = setTimeout(() => {
          void flushPendingNoteDeepLink();
        }, 1000);
      } else {
        console.warn("Note deep link could not resolve a local note");
        clearPendingNoteDeepLink();
      }
      return;
    }

    const payload = { noteId: note.id, folderId: note.folder_id ?? null };
    clearPendingNoteDeepLink();
    await windowManager.queueNoteNavigation(payload);
  } catch (error) {
    console.error("Note deep link failed", errorSummary(error));
    clearPendingNoteDeepLink();
  }
}

async function handleNoteDeepLink(cloudId) {
  clearPendingNoteDeepLink();
  pendingNoteCloudId = cloudId;
  await flushPendingNoteDeepLink();
}

function handleInvitationDeepLink(token) {
  try {
    if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
      windowManager.controlPanelWindow.webContents.send("workspace-invitation-token", token);
    } else if (windowManager) {
      windowManager.createControlPanelWindow();
      // Defer the send until renderer is ready; main.js relies on `did-finish-load`
      const win = windowManager.controlPanelWindow;
      if (win) {
        win.webContents.once("did-finish-load", () => {
          win.webContents.send("workspace-invitation-token", token);
        });
      }
    }
  } catch (error) {
    console.error("Invitation deep link parse failed", errorSummary(error));
  }
}

async function handleOAuthDeepLink(deepLinkUrl) {
  if (!desktopAuthManager) {
    throw protocolRouteError("AUTH_MANAGER_UNAVAILABLE");
  }
  await desktopAuthManager.handleCallback(deepLinkUrl);
  if (!windowManager) return;
  await windowManager.createControlPanelWindow();
  if (isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
    dockManager.setControlPanelVisible(true);
  }
}

function notifyDesktopUsageRefresh(reason) {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("desktop-usage-refresh", { reason });
  }
}

async function handleBillingCompleteDeepLink() {
  if (!windowManager) return;
  await windowManager.createControlPanelWindow();
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    notifyDesktopUsageRefresh("billing-complete");
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
    dockManager.setControlPanelVisible(true);
  }
}

// Main application startup
async function startApp() {
  reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  await initializeCoreManagers();
  await environmentManager.init();
  registerSidecars();

  cliBridge = new CliBridge(ipcHandlers);
  cliBridge.start().catch((err) => {
    debugLogger.error("CLI bridge failed to start", { error: err.message });
    cliBridge = null;
  });

  windowManager.setActivationModeCache(environmentManager.getActivationMode());
  windowManager.setFloatingIconAutoHide(environmentManager.getFloatingIconAutoHide());
  windowManager.setPanelStartPosition(environmentManager.getPanelStartPosition());

  onTrustedIpc("activation-mode-changed", (_event, mode) => {
    if (!new Set(["tap", "push"]).has(mode)) return;
    windowManager.setActivationModeCache(mode);
    environmentManager.saveActivationMode(mode);
  });

  onTrustedIpc("floating-icon-auto-hide-changed", (_event, enabled) => {
    if (typeof enabled !== "boolean") return;
    windowManager.setFloatingIconAutoHide(enabled);
    environmentManager.saveFloatingIconAutoHide(enabled);
    // Relay to the floating icon window so it can react immediately
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.mainWindow.webContents.send("floating-icon-auto-hide-changed", enabled);
    }
  });

  onTrustedIpc("start-minimized-changed", (_event, enabled) => {
    if (typeof enabled !== "boolean") return;
    if (debugLogger) debugLogger.info("Start minimized changed", { enabled });
    environmentManager.saveStartMinimized(enabled);
  });

  onTrustedIpc("panel-start-position-changed", (_event, position) => {
    if (!new Set(["bottom-left", "center", "bottom-right"]).has(position)) return;
    windowManager.setPanelStartPosition(position);
    environmentManager.savePanelStartPosition(position);
  });

  dockManager.init();

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible
  const startMinimized = environmentManager.getStartMinimized();
  if (debugLogger) debugLogger.info("Start minimized", { enabled: startMinimized });
  await windowManager.createMainWindow();
  if (!startMinimized) {
    await windowManager.createControlPanelWindow();
  }

  for (const initialProtocolUrl of initialProtocolUrls) {
    await safelyAcceptProtocolUrl(initialProtocolUrl);
  }
  protocolRouterReady = true;
  await flushPendingProtocolUrls();
  await flushPendingNoteDeepLink();

  // Create agent window (hidden) and set up agent hotkey
  await windowManager.createAgentWindow();

  const agentHotkeyCallback = () => {
    if (hotkeyManager.isInListeningMode()) return;
    windowManager.toggleAgentOverlay();
  };
  windowManager._agentHotkeyCallback = agentHotkeyCallback;

  const savedAgentKey = environmentManager.getAgentKey?.() || "";
  if (savedAgentKey) {
    const result = await hotkeyManager.registerSlot("agent", savedAgentKey, agentHotkeyCallback);
    if (!result.success) {
      debugLogger.warn("Failed to restore agent hotkey", { hotkey: savedAgentKey }, "hotkey");
    }
  }

  // Set up voice agent hotkey (dictation routed straight to the dictation
  // agent, bypassing cleanup)
  const voiceAgentHotkeyCallback = () => {
    windowManager.sendToggleVoiceAgent();
  };
  windowManager._voiceAgentHotkeyCallback = voiceAgentHotkeyCallback;

  const savedVoiceAgentKey = environmentManager.getVoiceAgentKey?.() || "";
  if (savedVoiceAgentKey) {
    const result = await hotkeyManager.registerSlot(
      "voiceAgent",
      savedVoiceAgentKey,
      voiceAgentHotkeyCallback
    );
    if (!result.success) {
      debugLogger.warn(
        "Failed to restore voice agent hotkey",
        { hotkey: savedVoiceAgentKey },
        "hotkey"
      );
    }
  }

  // Set up translation hotkey (dictation cleaned up and translated into the
  // configured target language before pasting)
  const translationHotkeyCallback = () => {
    windowManager.sendToggleTranslation();
  };
  windowManager._translationHotkeyCallback = translationHotkeyCallback;

  const savedTranslationKey = environmentManager.getTranslationKey?.() || "";
  if (savedTranslationKey) {
    const result = await hotkeyManager.registerSlot(
      "translation",
      savedTranslationKey,
      translationHotkeyCallback
    );
    if (!result.success) {
      debugLogger.warn(
        "Failed to restore translation hotkey",
        { hotkey: savedTranslationKey },
        "hotkey"
      );
    }
  }

  // Set up meeting mode hotkey
  const meetingHotkeyCallback = () => {
    if (hotkeyManager.isInListeningMode()) return;
    debugLogger.info("Meeting hotkey triggered", {}, "meeting");
    meetingDetectionEngine?.startManualMeeting();
  };

  const savedMeetingKey = environmentManager.getMeetingKey?.() || "";
  if (savedMeetingKey) {
    const result = await hotkeyManager.registerSlot(
      "meeting",
      savedMeetingKey,
      meetingHotkeyCallback
    );
    debugLogger.info(
      "Meeting hotkey startup registration",
      { savedMeetingKey, ...result },
      "meeting"
    );
  }

  handleTrustedIpc("register-meeting-hotkey", async (_event, hotkey) => {
    if (typeof hotkey !== "string" || hotkey.length > 128) {
      return { success: false, message: "Invalid hotkey" };
    }
    if (hotkey) {
      const result = await hotkeyManager.registerSlot("meeting", hotkey, meetingHotkeyCallback, {
        atomic: true,
      });
      windowManager.reconcileNativeKeyListeners();
      if (result.success) {
        environmentManager.saveMeetingKey(hotkey);
        return { success: true };
      }
      return { success: false, message: result.error };
    } else {
      hotkeyManager.unregisterSlot("meeting");
      environmentManager.saveMeetingKey("");
      windowManager.reconcileNativeKeyListeners();
      return { success: true };
    }
  });

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();

  app.on("browser-window-focus", () => {
    if (googleCalendarManager) googleCalendarManager.syncOnFocus();
  });

  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    if (googleCalendarManager) {
      googleCalendarManager.onWakeFromSleep();
    }
  });

  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
  }

  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();

  updateManager.checkForUpdatesOnStartup();

  // Local-only notification preview. This is deliberately opt-in and only
  // available when Electron is started in development mode.
  if (
    process.env.NODE_ENV === "development" &&
    process.env.VOICELAB_TEST_UPDATE_NOTIFICATION === "1"
  ) {
    setTimeout(() => {
      console.info("[dev] Showing a fake native update notification");
      updateManager.showNativeUpdateNotification({ version: "1.0.2-test" }, { preview: true });
    }, 1_000);
  }

  if (process.platform === "darwin") {
    const { isGlobeLikeHotkey, isMouseButtonHotkey } = require("./src/helpers/hotkeyManager");
    let globeKeyDownTime = 0;
    let globeKeyIsRecording = false;
    let globeLastStopTime = 0;
    const MIN_HOLD_DURATION_MS = 150;
    const POST_STOP_COOLDOWN_MS = 300;

    globeKeyManager.on("globe-down", async () => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      const mainWindowLive = isLiveWindow(windowManager.mainWindow);
      debugLogger?.debug("[Globe] globe-down received", {
        currentHotkey,
        mainWindowLive,
        activationMode: mainWindowLive ? windowManager.getActivationMode() : "n/a",
      });

      // Forward to control panel for hotkey capture
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
      }

      // Handle dictation if Globe/Fn is one of the dictation hotkeys
      const dictationUsesGlobe = hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey);
      if (dictationUsesGlobe) {
        if (mainWindowLive) {
          // Capture target app PID BEFORE showing the overlay
          if (textEditMonitor) textEditMonitor.captureTargetPid();
          const activationMode = windowManager.getActivationMode();
          if (activationMode === "push") {
            const now = Date.now();
            if (now - globeLastStopTime < POST_STOP_COOLDOWN_MS) {
              debugLogger?.debug("[Globe] Ignored — cooldown active");
              return;
            }
            windowManager.showDictationPanel();
            const pressTime = now;
            globeKeyDownTime = pressTime;
            globeKeyIsRecording = false;
            setTimeout(async () => {
              if (globeKeyDownTime === pressTime && !globeKeyIsRecording) {
                globeKeyIsRecording = true;
                debugLogger?.debug("[Globe] Starting dictation (push hold)");
                windowManager.sendStartDictation();
              }
            }, MIN_HOLD_DURATION_MS);
          } else {
            windowManager.sendToggleDictation();
          }
        } else {
          debugLogger?.debug("[Globe] Ignored — mainWindow not live");
        }
      }

      // Check agent and voice agent slots for Globe/Fn key
      const agentUsesGlobe = hotkeyManager.getSlotHotkeys("agent").some(isGlobeLikeHotkey);
      const voiceAgentUsesGlobe = hotkeyManager
        .getSlotHotkeys("voiceAgent")
        .some(isGlobeLikeHotkey);
      const translationUsesGlobe = hotkeyManager
        .getSlotHotkeys("translation")
        .some(isGlobeLikeHotkey);
      if (agentUsesGlobe) {
        windowManager.toggleAgentOverlay();
      }
      if (voiceAgentUsesGlobe) {
        windowManager.sendToggleVoiceAgent();
      }
      if (translationUsesGlobe) {
        windowManager.sendToggleTranslation();
      }
      if (!agentUsesGlobe && !voiceAgentUsesGlobe && !translationUsesGlobe && !dictationUsesGlobe) {
        debugLogger?.debug("[Globe] Ignored — hotkey is not GLOBE", { currentHotkey });
      }
    });

    globeKeyManager.on("globe-up", async () => {
      debugLogger?.debug("[Globe] globe-up received", { wasRecording: globeKeyIsRecording });

      // Forward to control panel for hotkey capture (Fn key released)
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-released");
      }

      if (hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey)) {
        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push") {
          globeKeyDownTime = 0;
          globeLastStopTime = Date.now();
          if (globeKeyIsRecording) {
            globeKeyIsRecording = false;
            debugLogger?.debug("[Globe] Stopping dictation (push release)");
            windowManager.sendStopDictation();
          }
        }
      }

      // Fn release also stops compound push-to-talk for Fn+F-key hotkeys
      windowManager.handleMacPushModifierUp("fn");
    });

    // Another key was pressed while Fn was held — user is using Fn as a
    // navigation modifier (Fn+Arrow → Home, Fn+Backspace → Forward Delete, etc.).
    // Cancel any bare-Fn push-to-talk in progress instead of transcribing noise.
    // Only the bare-Fn path uses globeKeyDownTime/globeKeyIsRecording, so compound
    // Fn-hotkey push-to-talk and tap mode are untouched.
    globeKeyManager.on("globe-interrupted", () => {
      if (globeKeyDownTime === 0 && !globeKeyIsRecording) {
        return;
      }
      const wasRecording = globeKeyIsRecording;
      debugLogger?.debug("[Globe] Fn+key interrupted push-to-talk", { wasRecording });
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = Date.now();
      if (wasRecording) {
        windowManager.sendCancelDictation();
      } else {
        windowManager.hideDictationPanel();
      }
    });

    globeKeyManager.on("modifier-up", (modifier) => {
      if (windowManager?.handleMacPushModifierUp) {
        windowManager.handleMacPushModifierUp(modifier);
      }
    });

    // Right-side single modifier handling (e.g., RightOption as hotkey)
    let rightModDownTime = 0;
    let rightModIsRecording = false;
    let rightModLastStopTime = 0;
    let rightModActiveKey = null;

    globeKeyManager.on("right-modifier-down", async (modifier) => {
      // Check agent and voice agent slots for right-modifier
      if (hotkeyManager.slotHasHotkey("agent", modifier)) {
        windowManager.toggleAgentOverlay();
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", modifier)) {
        windowManager.sendToggleVoiceAgent();
      }
      if (hotkeyManager.slotHasHotkey("translation", modifier)) {
        windowManager.sendToggleTranslation();
      }

      if (!hotkeyManager.slotHasHotkey("dictation", modifier)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (textEditMonitor) textEditMonitor.captureTargetPid();
      if (activationMode === "push") {
        if (rightModActiveKey && rightModActiveKey !== modifier) return;
        const now = Date.now();
        if (now - rightModLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        rightModActiveKey = modifier;
        rightModDownTime = pressTime;
        rightModIsRecording = false;
        setTimeout(() => {
          if (rightModDownTime === pressTime && !rightModIsRecording) {
            rightModIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.sendToggleDictation();
      }
    });

    globeKeyManager.on("right-modifier-up", async (modifier) => {
      if (hotkeyManager.slotHasHotkey("dictation", modifier)) {
        if (!isLiveWindow(windowManager.mainWindow)) return;

        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push" && (!rightModActiveKey || rightModActiveKey === modifier)) {
          rightModActiveKey = null;
          rightModDownTime = 0;
          rightModLastStopTime = Date.now();
          if (rightModIsRecording) {
            rightModIsRecording = false;
            windowManager.sendStopDictation();
          } else {
            windowManager.hideDictationPanel();
          }
        }
      }

      const rightModToBase = {
        RightCommand: "command",
        RightOption: "option",
        RightControl: "control",
        RightShift: "shift",
      };
      const baseMod = rightModToBase[modifier];
      if (baseMod && windowManager?.handleMacPushModifierUp) {
        windowManager.handleMacPushModifierUp(baseMod);
      }
    });

    const syncSuppressedMouseButtons = () => {
      const buttons = [];
      for (const slotName of ["dictation", "agent", "voiceAgent", "translation"]) {
        for (const hotkey of hotkeyManager.getSlotHotkeys(slotName)) {
          if (isMouseButtonHotkey(hotkey)) buttons.push(hotkey);
        }
      }
      globeKeyManager.setSuppressedMouseButtons(buttons);
    };

    // Mouse Button 4/5 handling (e.g., Logitech MX Master side buttons)
    let mouseButtonDownTime = 0;
    let mouseButtonIsRecording = false;
    let mouseButtonLastStopTime = 0;
    let mouseButtonActiveButton = null;

    globeKeyManager.on("mouse-button-down", async (button) => {
      if (hotkeyManager.isInListeningMode && hotkeyManager.isInListeningMode()) return;
      if (!isMouseButtonHotkey(button)) return;

      if (hotkeyManager.slotHasHotkey("agent", button)) {
        windowManager.toggleAgentOverlay();
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", button)) {
        windowManager.sendToggleVoiceAgent();
      }
      if (hotkeyManager.slotHasHotkey("translation", button)) {
        windowManager.sendToggleTranslation();
      }

      if (!hotkeyManager.slotHasHotkey("dictation", button)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (textEditMonitor) textEditMonitor.captureTargetPid();

      if (activationMode === "push") {
        if (mouseButtonActiveButton && mouseButtonActiveButton !== button) return;
        const now = Date.now();
        if (now - mouseButtonLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        mouseButtonActiveButton = button;
        mouseButtonDownTime = pressTime;
        mouseButtonIsRecording = false;
        setTimeout(() => {
          if (mouseButtonDownTime === pressTime && !mouseButtonIsRecording) {
            mouseButtonIsRecording = true;
            windowManager.sendStartDictation();
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.sendToggleDictation();
      }
    });

    globeKeyManager.on("mouse-button-up", async (button) => {
      if (hotkeyManager.isInListeningMode && hotkeyManager.isInListeningMode()) return;
      if (!isMouseButtonHotkey(button)) return;

      if (!hotkeyManager.slotHasHotkey("dictation", button)) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (
        activationMode === "push" &&
        (!mouseButtonActiveButton || mouseButtonActiveButton === button)
      ) {
        mouseButtonActiveButton = null;
        mouseButtonDownTime = 0;
        mouseButtonLastStopTime = Date.now();
        if (mouseButtonIsRecording) {
          mouseButtonIsRecording = false;
          windowManager.sendStopDictation();
        } else {
          windowManager.hideDictationPanel();
        }
      }
    });

    syncSuppressedMouseButtons();
    globeKeyManager.start();
    hotkeyManager.once("hotkey-loaded", syncSuppressedMouseButtons);

    onTrustedIpc("hotkey-listening-mode-changed", (_event, enabled) => {
      if (typeof enabled !== "boolean") return;
      if (enabled) {
        globeKeyManager.setSuppressedMouseButtons([]);
      } else {
        syncSuppressedMouseButtons();
      }
    });

    // Read-only status check. Missing Accessibility access is surfaced by the
    // permissions UI and paste result; startup and sign-in must never trigger
    // the native macOS prompt. The prompt is reserved for the explicit
    // "Grant access" action in Settings.
    handleTrustedIpc("check-accessibility-trusted", () => {
      return systemPreferences.isTrustedAccessibilityClient(false);
    });

    // Reset native key state when hotkey changes
    onTrustedIpc("hotkey-changed", (_event, newHotkey) => {
      if (typeof newHotkey !== "string" || newHotkey.length > 128) return;
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = 0;
      rightModDownTime = 0;
      rightModIsRecording = false;
      rightModLastStopTime = 0;
      mouseButtonDownTime = 0;
      mouseButtonIsRecording = false;
      mouseButtonLastStopTime = 0;
      syncSuppressedMouseButtons();
    });
  }

  // Windows and Linux share the same native low-level key listener model: one hook
  // process per watched key (Electron globalShortcut can't see modifier-only or
  // right-side-modifier combos), routed to the owning slot here. macOS is handled
  // separately above via globeKeyManager.
  if (process.platform === "win32" || process.platform === "linux") {
    const isWindows = process.platform === "win32";
    const nativeKeyManager = isWindows ? windowsKeyManager : linuxKeyManager;
    debugLogger.debug("[Push-to-Talk] Native key listener setup starting");

    // Dictation supports push-to-talk and needs the overlay window; agent/meeting
    // drive other windows (matching their globalShortcut callbacks and macOS).
    const dispatchNativeKeyDown = (key) => {
      if (hotkeyManager.slotHasHotkey("dictation", key)) {
        if (!isLiveWindow(windowManager.mainWindow)) return;
        if (windowManager.getActivationMode() === "push") {
          windowManager.startWindowsPushToTalk(key);
        } else {
          windowManager.sendToggleDictation();
        }
        return;
      }
      if (hotkeyManager.slotHasHotkey("voiceAgent", key)) {
        windowManager.sendToggleVoiceAgent();
      } else if (hotkeyManager.slotHasHotkey("translation", key)) {
        windowManager.sendToggleTranslation();
      } else if (hotkeyManager.slotHasHotkey("agent", key)) {
        if (!hotkeyManager.isInListeningMode()) windowManager.toggleAgentOverlay();
      } else if (hotkeyManager.slotHasHotkey("meeting", key)) {
        if (!hotkeyManager.isInListeningMode()) meetingDetectionEngine?.startManualMeeting();
      }
    };

    // Only dictation drives push-to-talk, so only its key-up matters.
    const dispatchNativeKeyUp = (key) => {
      if (!hotkeyManager.slotHasHotkey("dictation", key)) return;
      if (windowManager.winPushState?.active) {
        windowManager.handleWindowsPushKeyUp(key);
      } else if (
        isLiveWindow(windowManager.mainWindow) &&
        windowManager.getActivationMode() === "push"
      ) {
        windowManager.handleWindowsPushKeyUp(key);
      }
    };

    nativeKeyManager.on("key-down", dispatchNativeKeyDown);
    nativeKeyManager.on("key-up", dispatchNativeKeyUp);

    nativeKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Native key listener error", { error: error.message });
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    nativeKeyManager.on("unavailable", () => {
      debugLogger.debug(
        "[Push-to-Talk] Native key listener unavailable - falling back to toggle mode"
      );
      if (isWindows && isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: i18nMain.t("windows.pttUnavailable"),
        });
      }
    });

    nativeKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] Native key listener ready and listening");
    });

    if (!isWindows) {
      nativeKeyManager.on("permission-denied", () => {
        debugLogger.warn(
          "[Push-to-Talk] Linux key listener has no permission to access input devices"
        );
        if (isLiveWindow(windowManager.mainWindow)) {
          windowManager.mainWindow.webContents.send("linux-ptt-permission-denied");
        }
      });
    }

    const STARTUP_DELAY_MS = 3000;
    setTimeout(() => windowManager.reconcileNativeKeyListeners(), STARTUP_DELAY_MS);

    onTrustedIpc("activation-mode-changed", () => {
      windowManager.resetWindowsPushState();
      windowManager.reconcileNativeKeyListeners();
    });

    onTrustedIpc("hotkey-changed", () => {
      windowManager.resetWindowsPushState();
      windowManager.reconcileNativeKeyListeners();
    });
  }
}

// Listen for usage limit reached from dictation overlay, forward to control panel
onTrustedIpc("limit-reached", (_event, data) => {
  if (!data || typeof data !== "object" || JSON.stringify(data).length > 4096) return;
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("limit-reached", data);
  }
});

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", (_event, commandLine) => {
    void (async () => {
      await app.whenReady();
      if (!windowManager) {
        return;
      }

      if (isLiveWindow(windowManager.controlPanelWindow)) {
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
        if (windowManager.controlPanelWindow.webContents.isCrashed()) {
          windowManager.loadControlPanel();
        }
      } else {
        windowManager.createControlPanelWindow();
      }

      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.enforceMainWindowOnTop();
      } else {
        windowManager.createMainWindow();
      }

      const url = commandLine.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`));
      if (url) {
        await safelyAcceptProtocolUrl(url);
      }
    })().catch((error) => {
      notifyProtocolFailure(error);
    });
  });

  app
    .whenReady()
    .then(() => {
      // On Linux, --enable-transparent-visuals requires a short delay before creating
      // windows to allow the compositor to set up the ARGB visual correctly.
      // Without this delay, transparent windows flicker on both X11 and Wayland.
      const delay = process.platform === "linux" ? 300 : 0;
      return new Promise((resolve) => setTimeout(resolve, delay));
    })
    .then(() => {
      installSessionPermissionPolicy(session.defaultSession);
      if (process.platform === "win32") {
        session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
          const frame = request.frame;
          const requestingContents = frame ? webContents.fromFrame(frame) : null;
          const authorized = displayMediaGrantManager?.consume({
            webContentsId: requestingContents?.id,
            processId: frame?.processId,
            routingId: frame?.routingId,
            url: frame?.url,
            isTopLevel: Boolean(frame && frame.parent === null && frame.top === frame),
          });
          if (!authorized) {
            callback(null);
            return;
          }
          // Only the loopback audio track is used; the video source is
          // discarded by the renderer, so skip thumbnail generation.
          desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .then((sources) => {
              if (sources.length > 0) {
                callback({ video: sources[0], audio: "loopback" });
              } else {
                callback(null);
              }
            })
            .catch((error) => {
              console.error("Display media request failed", errorSummary(error));
              callback(null);
            });
        });
      }

      startApp().catch((error) => {
        console.error("Failed to start app", errorSummary(error));
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
        );
        app.exit(1);
      });
    });

  app.on("window-all-closed", () => {
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
    if (process.platform !== "darwin") {
      app.quit();
    }
    // On macOS, keep the app running even without windows
  });

  app.on("browser-window-focus", (event, window) => {
    // Only apply always-on-top to the dictation window, not the control panel
    if (windowManager && isLiveWindow(windowManager.mainWindow)) {
      // Check if the focused window is the dictation window
      if (window === windowManager.mainWindow) {
        windowManager.enforceMainWindowOnTop();
      }
    }

    if (window === windowManager?.controlPanelWindow) {
      notifyDesktopUsageRefresh("app-active");
    }

    // Control panel doesn't need any special handling on focus
    // It should behave like a normal window
  });

  app.on("activate", () => {
    // On macOS, re-create windows when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createMainWindow();
        windowManager.createControlPanelWindow();
      }
    } else {
      // Show control panel when dock icon is clicked (most common user action)
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
      } else if (windowManager) {
        // If control panel doesn't exist, create it
        windowManager.createControlPanelWindow();
      }

      // Ensure dictation panel maintains its always-on-top status
      if (windowManager && isLiveWindow(windowManager.mainWindow)) {
        windowManager.enforceMainWindowOnTop();
      }
    }
    notifyDesktopUsageRefresh("app-active");
  });

  let isShuttingDown = false;
  app.on("before-quit", (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      databaseManager?.sealAtRest?.();
    } catch (error) {
      debugLogger.error("Failed to seal local data at rest", {
        error: error?.message,
      });
    }
    if (updateManager && updateManager.isQuittingForUpdate) {
      // Quit must proceed for the installer to run, so no preventDefault;
      // sidecar shutdown is best-effort (the reaper cleans up orphans on relaunch).
      performSyncTeardown();
      sidecarRegistry.shutdownAll().catch(() => {});
      return;
    }
    event.preventDefault();
    performSyncTeardown();
    sidecarRegistry.shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown() {
  clearPendingNoteDeepLink();
  if (cliBridge) {
    cliBridge.stop().catch(() => {});
    cliBridge = null;
  }
  if (windowManager && isLiveWindow(windowManager.agentWindow)) {
    windowManager.agentWindow.destroy();
  }
  if (windowManager && isLiveWindow(windowManager.transcriptionPreviewWindow)) {
    windowManager.transcriptionPreviewWindow.destroy();
  }
  if (hotkeyManager) {
    hotkeyManager.unregisterAll();
  } else {
    globalShortcut.unregisterAll();
  }
  if (globeKeyManager) globeKeyManager.stop();
  if (windowsKeyManager) windowsKeyManager.stop();
  if (linuxKeyManager) linuxKeyManager.stop();
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (linuxPortalAudioManager) linuxPortalAudioManager.stop().catch(() => {});
  if (windowsLoopbackAudioManager) windowsLoopbackAudioManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
  if (ipcHandlers) ipcHandlers._cleanupTextEditMonitor();
  if (textEditMonitor) textEditMonitor.stopMonitoring();
  if (updateManager) updateManager.cleanup();
}
