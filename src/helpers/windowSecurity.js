const path = require("path");
const { pathToFileURL } = require("url");
const { shell } = require("electron");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");

const MAX_URL_LENGTH = 4096;

function getAllowedRendererLocation() {
  if (DevServerManager.isDevelopment()) {
    return {
      kind: "development",
      origin: new URL(DevServerManager.DEV_SERVER_URL).origin,
    };
  }
  const fileInfo = DevServerManager.getAppFilePath(false);
  return {
    kind: "file",
    href: pathToFileURL(path.resolve(fileInfo.path)).href,
  };
}

function isAllowedRendererUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return false;
  }
  let candidate;
  try {
    candidate = new URL(rawUrl);
  } catch {
    return false;
  }
  const allowed = getAllowedRendererLocation();
  if (allowed.kind === "development") {
    return candidate.protocol === "http:" && candidate.origin === allowed.origin;
  }
  const expected = new URL(allowed.href);
  return (
    candidate.protocol === "file:" &&
    path.resolve(decodeURIComponent(candidate.pathname)) ===
      path.resolve(decodeURIComponent(expected.pathname))
  );
}

function isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    const candidate = new URL(rawUrl);
    if (candidate.username || candidate.password) return false;
    if (candidate.protocol === "https:") return true;
    return candidate.protocol === "mailto:" && !/[\r\n]/.test(decodeURIComponent(rawUrl));
  } catch {
    return false;
  }
}

async function openExternalUrl(rawUrl) {
  if (!isAllowedExternalUrl(rawUrl)) {
    const error = new Error("External URL is not allowed");
    error.code = "EXTERNAL_URL_FORBIDDEN";
    throw error;
  }
  await shell.openExternal(rawUrl, { activate: true });
}

function hardenWindow(window) {
  if (!window || window.isDestroyed()) return;

  const blockOrOpenExternal = (event, url, isMainFrame) => {
    if (isAllowedRendererUrl(url)) return;
    event.preventDefault();
    if (isMainFrame && isAllowedExternalUrl(url)) {
      void openExternalUrl(url).catch((error) => {
        debugLogger.warn("external navigation failed", { code: error?.code });
      });
    }
  };

  window.webContents.on("will-navigate", (event, url) => {
    blockOrOpenExternal(event, url, true);
  });
  window.webContents.on("will-frame-navigate", (event, url, _isInPlace, isMainFrame) => {
    blockOrOpenExternal(event, url, isMainFrame === true);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void openExternalUrl(url).catch(() => {});
    }
    return { action: "deny" };
  });
}

module.exports = {
  hardenWindow,
  isAllowedExternalUrl,
  isAllowedRendererUrl,
  openExternalUrl,
};
