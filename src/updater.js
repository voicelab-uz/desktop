const { app, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const { i18nMain } = require("./helpers/i18nMain");
const { publicUpdateInfo } = require("./helpers/releaseNotes");
const { resolveUpdateFeed } = require("./helpers/updateFeedConfig");
const { isAllowedUpdate } = require("./helpers/versionComparison");
const { shouldRemindAboutUpdate, recordUpdateReminder } = require("./helpers/updateReminderStore");

const CREATIVE_UPDATE_MESSAGE_KEYS = [
  "betterListener",
  "listenHarder",
  "improveItself",
  "fixedEarly",
];

class UpdateManager {
  constructor() {
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.availableUpdateInfo = null;
    this.downloadedUpdateInfo = null;
    this.downloadProgress = 0;
    this.isInstalling = false;
    this.installAttempt = 0;
    this.isDownloading = false;
    this.isQuittingForUpdate = false;
    this.handleBeforeQuitForUpdate = null;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.startupCheckTimer = null;
    this.updateRetryTimer = null;
    this.updateRetryAttempt = 0;
    this.stopped = false;
    this.windowManager = null;
    this.authManager = null;
    this._suppressNotification = false;
    this.nativeUpdateNotification = null;

    this.setupAutoUpdater();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setAuthManager(authManager) {
    this.authManager = authManager;
  }

  areNativeUpdateNotificationsEnabled() {
    const preferences = this.windowManager?.notificationPrefs || {};
    return preferences.notificationsEnabled !== false && preferences.notifyUpdates !== false;
  }

  reconcileNativeUpdateNotification() {
    if (this.areNativeUpdateNotificationsEnabled() || !this.nativeUpdateNotification) return;
    this.nativeUpdateNotification.close();
    this.nativeUpdateNotification = null;
  }

  setupAutoUpdater() {
    if (!app.isPackaged && process.env.NODE_ENV === "development") {
      return;
    }

    autoUpdater.setFeedURL(
      resolveUpdateFeed({
        isPackaged: app.isPackaged,
        nodeEnv: process.env.NODE_ENV,
        owner: process.env.UPDATE_OWNER,
        repo: process.env.UPDATE_REPO,
      })
    );

    // Use arch-specific update channel on macOS to prevent arm64/x64
    // from downloading mismatched artifacts. Both builds publish to the
    // same GitHub release, so without this they race on latest-mac.yml.
    // Setting channel to e.g. 'latest-arm64' makes the updater look for
    // 'latest-arm64-mac.yml' instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: if an x64 build is running on Apple Silicon,
      // sysctl.proc_translated returns "1". This self-heals users who
      // got stuck on the x64 build from older releases.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore
        }
      }

      autoUpdater.channel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";
    }

    // Assign after channel: electron-updater's channel setter enables downgrades.
    autoUpdater.allowDowngrade = false;

    autoUpdater.autoDownload = false;
    // Never interrupt work: a downloaded update is offered through a native
    // "Restart & install" action. If it is dismissed, apply it when the user
    // next quits VoiceLab normally.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        if (!info?.version || !isAllowedUpdate(info.version, app.getVersion())) {
          this.updateAvailable = false;
          this._suppressNotification = false;
          this.availableUpdateInfo = null;
          this.notifyRenderers("update-not-available", publicUpdateInfo(info));
          return;
        }
        this.updateAvailable = true;
        this.availableUpdateInfo = publicUpdateInfo(info);
        const publicInfo = publicUpdateInfo(info);
        this.notifyRenderers("update-available", publicInfo);
        if (
          !this.updateDownloaded &&
          !this._suppressNotification &&
          this.areNativeUpdateNotificationsEnabled()
        ) {
          this.showNativeUpdateNotification(publicInfo);
        }
        this._suppressNotification = false;
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        this.availableUpdateInfo = null;
        this._suppressNotification = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        console.error("❌ Auto-updater error:", err);
        this._suppressNotification = false;
        this.isDownloading = false;
        this.recoverFailedInstall();
        this.notifyRenderers("update-error", err);
      },
      "download-progress": (progressObj) => {
        this.downloadProgress = progressObj.percent;
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        if (!info?.version || !isAllowedUpdate(info.version, app.getVersion())) {
          this.updateAvailable = false;
          this.updateDownloaded = false;
          this.isDownloading = false;
          this.availableUpdateInfo = null;
          this.downloadedUpdateInfo = null;
          this.notifyRenderers("update-not-available", publicUpdateInfo(info));
          return;
        }
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        this.downloadProgress = 100;
        this.downloadedUpdateInfo = publicUpdateInfo(info);
        const publicInfo = publicUpdateInfo(info);
        this.notifyRenderers("update-downloaded", publicInfo);
        this.showNativeUpdateNotification(publicInfo, { readyToInstall: true });
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });

    // electron-updater and Squirrel.Mac emit this on Electron's native
    // autoUpdater (before any windows close), not on the electron-updater instance.
    this.handleBeforeQuitForUpdate = () => {
      this.isQuittingForUpdate = true;
      if (this.windowManager) {
        this.windowManager.isQuitting = true;
        this.windowManager.hotkeyManager.unregisterAll();
      }
    };
    require("electron").autoUpdater.on("before-quit-for-update", this.handleBeforeQuitForUpdate);
  }

  notifyRenderers(channel, data) {
    // Read window refs live from windowManager: cached refs go stale when the
    // control panel is created after boot (start minimized) or recreated.
    const { mainWindow, controlPanelWindow } = this.windowManager ?? {};
    for (const win of [mainWindow, controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  recoverFailedInstall() {
    if (!this.isInstalling || this.isQuittingForUpdate) return;
    this.installAttempt += 1;
    this.isInstalling = false;
    this.authManager?.resumeBackgroundRefresh?.();
  }

  showNativeUpdateNotification(info, { preview = false, readyToInstall = false } = {}) {
    // Preview is an explicit developer action. Every ordinary native update
    // notification, including the post-download one, obeys user preferences.
    if (!preview && !this.areNativeUpdateNotificationsEnabled()) {
      return false;
    }

    if (!Notification.isSupported()) {
      console.warn("Native notifications are not supported on this system");
      return false;
    }

    // A pending update remains available from the in-app update control.
    // Availability reminders are limited to once per version per two hours;
    // completion notifications are always shown after a user starts a download.
    if (!preview && !readyToInstall && !shouldRemindAboutUpdate(info?.version)) {
      return false;
    }

    if (this.nativeUpdateNotification) {
      this.nativeUpdateNotification.close();
      this.nativeUpdateNotification = null;
    }

    const messageKey =
      CREATIVE_UPDATE_MESSAGE_KEYS[Math.floor(Math.random() * CREATIVE_UPDATE_MESSAGE_KEYS.length)];
    const messagePath = `updateNotification.messages.${messageKey}`;
    const canUseActions = process.platform === "darwin" || process.platform === "win32";
    const title = readyToInstall
      ? i18nMain.t("controlPanel.update.readyTitle")
      : i18nMain.t(`${messagePath}.title`);
    const body = readyToInstall
      ? i18nMain.t("controlPanel.update.readyDescription")
      : i18nMain.t(`${messagePath}.description`);
    const primaryActionText = readyToInstall
      ? i18nMain.t("controlPanel.update.installButton")
      : i18nMain.t("updateNotification.update");
    const notification = new Notification({
      id: `update-${info.version}`,
      groupId: "updates",
      title,
      body,
      ...(canUseActions
        ? {
            actions: [{ type: "button", text: primaryActionText }],
          }
        : { urgency: "normal", timeoutType: "never" }),
    });

    const runPrimaryAction = () => {
      if (preview) {
        console.info("[dev] Fake update notification action selected");
        return;
      }

      const action = this.updateDownloaded ? this.installUpdate() : this.downloadUpdate();
      void action
        .then((result) => {
          if (!result.success) throw new Error(result.message);
        })
        .catch((error) => {
          console.error(
            readyToInstall
              ? "Failed to install the downloaded update from native notification:"
              : "Failed to start update download from native notification:",
            error
          );
        });
    };

    const openUpdateAction = async () => {
      if (preview) {
        console.info("[dev] Fake update notification opened");
        return;
      }

      try {
        // The sidebar exposes a persistent Update action after this window opens.
        await this.windowManager?.createControlPanelWindow?.();
      } catch (error) {
        console.error("Failed to open VoiceLab from native update notification:", error);
      }
    };

    this.nativeUpdateNotification = notification;
    notification.on("click", () => {
      void openUpdateAction();
    });
    notification.on("action", (_event, actionIndex) => {
      if (actionIndex === 0) runPrimaryAction();
    });
    notification.on("failed", (_event, error) => {
      console.error("Failed to display native update notification:", error);
    });
    notification.once("show", () => {
      if (preview || readyToInstall) return;
      try {
        recordUpdateReminder(info.version);
      } catch (error) {
        console.warn("Failed to record native update reminder:", error);
      }
    });
    notification.on("close", () => {
      if (this.nativeUpdateNotification === notification) {
        this.nativeUpdateNotification = null;
      }
    });
    notification.show();
    return true;
  }

  async checkForUpdates() {
    try {
      if (!app.isPackaged && process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      console.log("🔍 Checking for updates...");
      this._suppressNotification = true;
      const result = await autoUpdater.checkForUpdates();

      if (
        result?.isUpdateAvailable &&
        result?.updateInfo?.version &&
        isAllowedUpdate(result.updateInfo.version, app.getVersion())
      ) {
        console.log("📋 Update available:", result.updateInfo.version);
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          releaseNotes: publicUpdateInfo(result.updateInfo)?.releaseNotes || "",
        };
      } else {
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
        };
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async downloadUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      if (
        !this.updateAvailable ||
        !this.availableUpdateInfo?.version ||
        !isAllowedUpdate(this.availableUpdateInfo.version, app.getVersion())
      ) {
        this.updateAvailable = false;
        this.availableUpdateInfo = null;
        return {
          success: false,
          message: "No newer update is available",
        };
      }

      this.isDownloading = true;
      this.downloadProgress = 0;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  async installUpdate() {
    let attempt = null;
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      attempt = ++this.installAttempt;
      console.log("🔄 Installing update and restarting...");

      // A background token refresh can be mid-flight right when someone clicks
      // Install & Restart. Refresh tokens are single-use, so if we quit before
      // the new one lands on disk, the relaunched app comes back up holding a
      // token the server already burned - that's a permanent "session expired",
      // not something a retry can fix. Let anything in flight finish first, and
      // stop new ones from starting during the quit sequence that follows.
      await this.authManager?.drainRefreshForShutdown?.();

      // An updater error can arrive while the token refresh is settling.
      if (!this.isInstalling || attempt !== this.installAttempt) {
        return { success: false, message: "Update installation failed. Please try again." };
      }

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      // Some platforms report installer failure through the error event rather
      // than throwing from quitAndInstall().
      if (!this.isInstalling || attempt !== this.installAttempt) {
        return { success: false, message: "Update installation failed. Please try again." };
      }

      return { success: true, message: "Update installation started" };
    } catch (error) {
      if (attempt === this.installAttempt) this.recoverFailedInstall();
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
        isDownloading: this.isDownloading,
        isInstalling: this.isInstalling,
        downloadProgress: this.downloadProgress,
        info: this.downloadedUpdateInfo || this.availableUpdateInfo,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.downloadedUpdateInfo || this.availableUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  async checkForUpdatesInBackground() {
    if (this.stopped || this.isInstalling) return;
    try {
      await autoUpdater.checkForUpdates();
      clearTimeout(this.updateRetryTimer);
      this.updateRetryTimer = null;
      this.updateRetryAttempt = 0;
    } catch (error) {
      console.error("Background update check failed:", error);
      // An offline launch should recover promptly without a permanent retry loop.
      const retryDelays = [30_000, 120_000, 300_000];
      if (!this.stopped && !this.updateRetryTimer && this.updateRetryAttempt < retryDelays.length) {
        const delay = retryDelays[this.updateRetryAttempt++];
        this.updateRetryTimer = setTimeout(() => {
          this.updateRetryTimer = null;
          void this.checkForUpdatesInBackground();
        }, delay);
      }
    }
  }

  checkForUpdatesOnStartup() {
    if (process.env.NODE_ENV !== "development") {
      this.stopped = false;
      this.startupCheckTimer = setTimeout(() => {
        this.startupCheckTimer = null;
        void this.checkForUpdatesInBackground();
      }, 3000);

      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      this.updateCheckInterval = setInterval(() => {
        this.updateRetryAttempt = 0;
        void this.checkForUpdatesInBackground();
      }, TWO_HOURS_MS);
    }
  }

  cleanup() {
    this.stopped = true;
    clearTimeout(this.startupCheckTimer);
    clearTimeout(this.updateRetryTimer);
    this.startupCheckTimer = null;
    this.updateRetryTimer = null;
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
    if (this.nativeUpdateNotification) {
      this.nativeUpdateNotification.close();
      this.nativeUpdateNotification = null;
    }
    if (this.handleBeforeQuitForUpdate) {
      require("electron").autoUpdater.removeListener(
        "before-quit-for-update",
        this.handleBeforeQuitForUpdate
      );
      this.handleBeforeQuitForUpdate = null;
    }
  }
}

module.exports = UpdateManager;
