const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

// Regression coverage for the "Install & Restart" crash (#1012): a manual
// app.emit("before-quit") with no Event object made event.preventDefault()
// throw on the first click. The retry only appeared to work because the
// crash left isShuttingDown = true, causing an accidental early-return.

test("before-quit is never manually emitted without a real Event object", () => {
  const main = read("main.js");
  const updater = read("src/updater.js");
  const pattern = /app\.emit\(\s*["']before-quit["']/;
  const reason =
    "manually emitting before-quit skips Electron's Event object and crashes any listener that calls event.preventDefault()";

  assert.doesNotMatch(main, pattern, reason);
  assert.doesNotMatch(updater, pattern, reason);
});

test("update-triggered quit is driven by autoUpdater state, not a synthetic event", () => {
  const main = read("main.js");
  assert.match(
    main,
    /app\.on\(\s*["']before-quit["']\s*,\s*\(event\)\s*=>/,
    "before-quit must be a real Electron listener that receives an Event object"
  );
  assert.match(
    main,
    /updateManager\s*&&\s*updateManager\.isQuittingForUpdate/,
    "the quit handler must branch on UpdateManager's own isQuittingForUpdate flag"
  );
});

test("before-quit-for-update is registered on Electron's native autoUpdater, not the electron-updater instance", () => {
  const updater = read("src/updater.js");

  // electron-updater (and Squirrel.Mac natively) emits this event on
  // require("electron").autoUpdater, before any windows close - never on the
  // electron-updater package's own autoUpdater export. Registering it on the
  // wrong emitter means it silently never fires: windowManager.isQuitting
  // stays false, the control panel intercepts the close, and the installer
  // hangs waiting for window-all-closed.
  assert.match(
    updater,
    /require\(["']electron["']\)\.autoUpdater\.on\(\s*["']before-quit-for-update["']/,
    "before-quit-for-update must be registered on require(\"electron\").autoUpdater"
  );

  const wrongEmitterPattern = /(?<!require\(["']electron["']\)\.)\bautoUpdater\.on\(\s*["']before-quit-for-update["']/;
  assert.doesNotMatch(
    updater,
    wrongEmitterPattern,
    "before-quit-for-update must not be registered on the electron-updater instance"
  );
});

test("the update quit handler sets isQuittingForUpdate and windowManager.isQuitting", () => {
  const updater = read("src/updater.js");
  const handlerStart = updater.indexOf("this.handleBeforeQuitForUpdate = () => {");
  assert.notEqual(handlerStart, -1, "handleBeforeQuitForUpdate must exist as an instance property");

  const handlerEnd = updater.indexOf("};", handlerStart);
  const handlerBody = updater.slice(handlerStart, handlerEnd);

  assert.match(handlerBody, /this\.isQuittingForUpdate\s*=\s*true/);
  assert.match(handlerBody, /this\.windowManager\.isQuitting\s*=\s*true/);
});
