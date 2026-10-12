const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// macOS runs its own action when the fn/Globe key is pressed on its own (Emoji
// picker, input-source switcher or Dictation). That action is decided below
// event taps, so while VoiceLab dictates with fn the system setting itself is
// switched to "Do Nothing" through the Globe listener helper, which also applies
// it live. The previous value is kept so it can be restored.
const DO_NOTHING = 0;
const BACKUP_FILE = "fn-usage-backup.json";

let queue = Promise.resolve();

function backupPath() {
  return path.join(app.getPath("userData"), BACKUP_FILE);
}

function runHelper(binaryPath, args) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ["--fn-usage", ...args], { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || "").trim());
    });
  });
}

function parseValue(output) {
  if (output === "absent") return null;
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBackup() {
  try {
    const parsed = JSON.parse(fs.readFileSync(backupPath(), "utf8"));
    return typeof parsed?.previous === "number" ? parsed.previous : null;
  } catch {
    return null;
  }
}

function hasBackup() {
  return fs.existsSync(backupPath());
}

function writeBackup(previous) {
  fs.writeFileSync(backupPath(), JSON.stringify({ previous, savedAt: Date.now() }), {
    mode: 0o600,
  });
}

function clearBackup() {
  try {
    fs.unlinkSync(backupPath());
  } catch {}
}

function restoreArgs(previous) {
  return previous === null ? ["delete"] : ["set", String(previous)];
}

/**
 * Keep the system fn-key action silent while dictation is bound to fn/Globe,
 * and put the previous action back as soon as it no longer is.
 */
function syncMacosFnKeyPolicy(dictationUsesFn, binaryPath) {
  if (process.platform !== "darwin" || !binaryPath) return Promise.resolve();
  queue = queue
    .then(async () => {
      const current = parseValue(await runHelper(binaryPath, ["get"]));
      if (dictationUsesFn) {
        if (current === DO_NOTHING) return;
        if (!hasBackup()) writeBackup(current);
        const result = await runHelper(binaryPath, ["set", String(DO_NOTHING)]);
        debugLogger.info("[FnKeyPolicy] System fn action disabled for dictation", {
          previous: current,
          result,
        });
        return;
      }
      if (!hasBackup()) return;
      const previous = readBackup();
      if (current === DO_NOTHING) {
        const result = await runHelper(binaryPath, restoreArgs(previous));
        debugLogger.info("[FnKeyPolicy] System fn action restored", { previous, result });
      }
      clearBackup();
    })
    .catch((error) => {
      debugLogger.warn("[FnKeyPolicy] Could not update the system fn action", {
        error: error?.message,
      });
    });
  return queue;
}

/** Synchronous restore for app quit, when async work may not finish in time. */
function restoreMacosFnKeyPolicySync(binaryPath) {
  if (process.platform !== "darwin" || !binaryPath || !hasBackup()) return;
  try {
    execFileSync(binaryPath, ["--fn-usage", ...restoreArgs(readBackup())], {
      timeout: 3000,
      stdio: "ignore",
    });
  } catch {
    // Best effort: the backup stays so the next launch can retry.
    return;
  }
  clearBackup();
}

module.exports = { syncMacosFnKeyPolicy, restoreMacosFnKeyPolicySync };
