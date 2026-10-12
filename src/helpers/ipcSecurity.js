const { BrowserWindow } = require("electron");
const { isAllowedRendererUrl } = require("./windowSecurity");

const CONTROL_PANEL_ONLY = [
  /^auth-(?:start-browser|refresh-session|logout|delete-account)$/,
  /^auth-clear-session$/,
  /^db-clear-transcriptions$/,
  /^db-(?:delete-transcription|set-dictionary|save-note|update-note|delete-note|semantic-reindex-all|update-note-cloud-id|create-folder|delete-folder|rename-folder|create-action|update-action|delete-action)$/,
  /^desktop-dictionary-(?:create|update|delete|legacy-decision)$/,
  /^delete-transcription-audio$/,
  /^delete-all-audio$/,
  /^cleanup-app$/,
  /^note-files-(?:set-enabled|set-path|rebuild|pick-folder)$/,
  /^(?:download|delete)-diarization-models$/,
  /^llama-cpp-(?:install|uninstall)$/,
  /^(?:download|delete)-llama-vulkan-binary$/,
  /^model-(?:download|cancel-download|delete|delete-all)$/,
  /^set-auto-start-enabled$/,
  /^gcal-/,
  /^(?:check-for-updates|download-update|install-update)$/,
  /^workspace-api-request$/,
  /^arm-display-media-capture$/,
  /^provider-(?:save-credential|save-endpoint|list-models|tinfoil-models|transcribe-file)$/,
  /^save-(?:bedrock-(?:region|profile)|azure-(?:endpoint|deployment|api-version)|vertex-(?:project|location))$/,
  /^save-.*(?:key|secret|token|credential)/,
];

const MAIN_OR_CONTROL = [/^get-.*(?:key|secret|token|credential)/];

function assertTrustedIpcSender(event, channel, windowManager) {
  if (!event?.sender || event.sender.isDestroyed()) {
    const error = new Error("IPC sender is unavailable");
    error.code = "IPC_SENDER_INVALID";
    throw error;
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    const error = new Error("IPC is only available to the top-level application frame");
    error.code = "IPC_SUBFRAME_FORBIDDEN";
    throw error;
  }
  if (!isAllowedRendererUrl(event.senderFrame.url)) {
    const error = new Error("IPC sender URL is not trusted");
    error.code = "IPC_ORIGIN_FORBIDDEN";
    throw error;
  }

  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const knownWindows = [
    windowManager?.mainWindow,
    windowManager?.controlPanelWindow,
    windowManager?.agentWindow,
    windowManager?.notificationWindow,
    windowManager?.transcriptionPreviewWindow,
    windowManager?.accessibilityDropWindow,
  ].filter(Boolean);
  if (!senderWindow || !knownWindows.includes(senderWindow)) {
    const error = new Error("IPC sender window is not registered");
    error.code = "IPC_WINDOW_FORBIDDEN";
    throw error;
  }

  if (
    CONTROL_PANEL_ONLY.some((pattern) => pattern.test(channel)) &&
    senderWindow !== windowManager?.controlPanelWindow
  ) {
    const error = new Error("IPC capability is restricted to the control panel");
    error.code = "IPC_CAPABILITY_FORBIDDEN";
    throw error;
  }
  if (
    MAIN_OR_CONTROL.some((pattern) => pattern.test(channel)) &&
    ![windowManager?.mainWindow, windowManager?.controlPanelWindow].includes(senderWindow)
  ) {
    const error = new Error("IPC capability is restricted to application windows");
    error.code = "IPC_CAPABILITY_FORBIDDEN";
    throw error;
  }
}

function createSecureHandler(ipcMain, windowManager) {
  return (channel, handler) => {
    if (typeof channel !== "string" || typeof handler !== "function") {
      throw new TypeError("Invalid IPC handler registration");
    }
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcSender(event, channel, windowManager);
      return handler(event, ...args);
    });
  };
}

function createSecureListener(ipcMain, windowManager) {
  return (channel, listener) => {
    if (typeof channel !== "string" || typeof listener !== "function") {
      throw new TypeError("Invalid IPC listener registration");
    }
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertTrustedIpcSender(event, channel, windowManager);
        const result = listener(event, ...args);
        if (result && typeof result.catch === "function") {
          result.catch(() => {
            console.warn(`IPC listener failed: ${channel}`);
          });
        }
      } catch {
        console.warn(`Rejected IPC listener request: ${channel}`);
      }
    });
  };
}

module.exports = { assertTrustedIpcSender, createSecureHandler, createSecureListener };
