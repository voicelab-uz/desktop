import { useState, useEffect, useCallback } from "react";
import type { UpdateStatusResult } from "../types/electron";

interface UpdateStatus {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

interface UpdateInfo {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  downloadProgress: number;
  isChecking: boolean;
  isDownloading: boolean;
  isInstalling: boolean;
  error: Error | null;
}

export type PrimaryUpdateAction = "install" | "download" | null;

// The one rule for "what should clicking the update button do right now" -
// every surface that offers an update action (the sidebar, Settings, the
// sign-in screen) reads this instead of re-deriving it, so the two can't
// silently drift as update states change.
export function primaryUpdateAction(
  status: UpdateStatus,
  isDownloading: boolean
): PrimaryUpdateAction {
  if (status.updateDownloaded) return "install";
  if (status.updateAvailable && !isDownloading) return "download";
  return null;
}

let globalState: UpdateState = {
  status: {
    updateAvailable: false,
    updateDownloaded: false,
    isDevelopment: false,
  },
  info: null,
  downloadProgress: 0,
  isChecking: false,
  isDownloading: false,
  isInstalling: false,
  error: null,
};

const stateListeners = new Set<(state: UpdateState) => void>();
let listenersRegistered = false;
const cleanupFunctions: Array<() => void> = [];
let stateRevision = 0;
let installRequest = 0;
let statusRefreshPromise: Promise<void> | null = null;
let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function getDevelopmentProgressPreview(): number | null {
  if (!import.meta.env.DEV) return null;

  const value = new URLSearchParams(window.location.search).get("update-progress-preview");
  if (!value) return null;

  const progress = Number(value);
  return Number.isFinite(progress) ? Math.min(99, Math.max(0, progress)) : 62;
}

function notifyListeners() {
  stateListeners.forEach((listener) => listener({ ...globalState }));
}

function updateGlobalState(updates: Partial<UpdateState>) {
  stateRevision += 1;
  globalState = { ...globalState, ...updates };
  notifyListeners();
}

async function refreshUpdateStatus() {
  if (!window.electronAPI?.getUpdateStatus) return;
  if (statusRefreshPromise) return statusRefreshPromise;
  statusRefreshPromise = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = stateRevision;
      const status: UpdateStatusResult = await window.electronAPI.getUpdateStatus();
      // Events carry only part of the state. Re-read after a race instead of
      // permanently dropping the initial downloaded version or busy state.
      if (revision !== stateRevision) continue;
      updateGlobalState({
        status,
        info: status.info ?? null,
        isDownloading: status.isDownloading ?? false,
        isInstalling: status.isInstalling ?? false,
        downloadProgress: status.downloadProgress ?? (status.updateDownloaded ? 100 : 0),
      });
      return;
    }
    // Avoid a tight loop if progress events keep arriving during hydration.
    if (stateListeners.size > 0 && !statusRefreshTimer) {
      statusRefreshTimer = setTimeout(() => {
        statusRefreshTimer = null;
        void refreshUpdateStatus().catch((error) => {
          console.error("Failed to refresh update status:", error);
        });
      }, 100);
    }
  })().finally(() => {
    statusRefreshPromise = null;
  });
  return statusRefreshPromise;
}

function registerEventListeners() {
  if (listenersRegistered || !window.electronAPI) {
    return;
  }

  listenersRegistered = true;

  if (window.electronAPI.onUpdateAvailable) {
    const dispose = window.electronAPI.onUpdateAvailable((_event, info) => {
      updateGlobalState({
        status: { ...globalState.status, updateAvailable: true },
        info: globalState.status.updateDownloaded ? globalState.info : info || globalState.info,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateNotAvailable) {
    const dispose = window.electronAPI.onUpdateNotAvailable(() => {
      // Preserve downloaded state — don't nuke a pending install
      const keepDownloaded = globalState.status.updateDownloaded;
      updateGlobalState({
        status: {
          ...globalState.status,
          updateAvailable: false,
          updateDownloaded: keepDownloaded,
        },
        info: keepDownloaded ? globalState.info : null,
        isChecking: false,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateDownloaded) {
    const dispose = window.electronAPI.onUpdateDownloaded((_event, info) => {
      updateGlobalState({
        status: { ...globalState.status, updateDownloaded: true },
        info: info || globalState.info,
        downloadProgress: 100,
        isDownloading: false,
        isInstalling: false,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateDownloadProgress) {
    const dispose = window.electronAPI.onUpdateDownloadProgress((_event, progressObj) => {
      updateGlobalState({
        downloadProgress: progressObj?.percent || 0,
        isDownloading: true,
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }

  if (window.electronAPI.onUpdateError) {
    const dispose = window.electronAPI.onUpdateError((_event, error) => {
      installRequest += 1;
      updateGlobalState({
        isChecking: false,
        isDownloading: false,
        isInstalling: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    if (dispose) cleanupFunctions.push(dispose);
  }
}

function cleanup() {
  if (stateListeners.size === 0 && statusRefreshTimer) {
    clearTimeout(statusRefreshTimer);
    statusRefreshTimer = null;
  }
  if (stateListeners.size === 0 && listenersRegistered) {
    cleanupFunctions.forEach((fn) => fn());
    cleanupFunctions.length = 0;
    listenersRegistered = false;
  }
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(globalState);

  useEffect(() => {
    stateListeners.add(setState);

    const previewProgress = getDevelopmentProgressPreview();
    if (previewProgress !== null) {
      updateGlobalState({
        status: { updateAvailable: true, updateDownloaded: false, isDevelopment: false },
        info: { version: "0.1.15" },
        downloadProgress: previewProgress,
        isChecking: false,
        isDownloading: true,
        isInstalling: false,
        error: null,
      });

      return () => {
        stateListeners.delete(setState);
        cleanup();
      };
    }

    registerEventListeners();

    const initializeUpdateStatus = async () => {
      try {
        await refreshUpdateStatus();
      } catch (error) {
        console.error("Failed to initialize update status:", error);
      }
    };

    initializeUpdateStatus();

    return () => {
      stateListeners.delete(setState);
      cleanup();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    updateGlobalState({ isChecking: true, error: null });
    try {
      const result = await window.electronAPI.checkForUpdates();
      updateGlobalState({ isChecking: false });
      return result;
    } catch (error) {
      updateGlobalState({
        isChecking: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (state.status.updateDownloaded) {
      return { success: true, message: "Update already downloaded" };
    }

    updateGlobalState({ isDownloading: true, downloadProgress: 0, error: null });
    try {
      const result = await window.electronAPI.downloadUpdate();
      if (!result.success) throw new Error(result.message);
      await refreshUpdateStatus();
      return result;
    } catch (error) {
      updateGlobalState({
        isDownloading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }, [state.status.updateDownloaded]);

  const installUpdate = useCallback(async () => {
    if (!state.status.updateDownloaded) {
      throw new Error("No update available to install");
    }

    const request = ++installRequest;
    updateGlobalState({ isInstalling: true, error: null });
    try {
      const result = await window.electronAPI.installUpdate();
      if (!result.success) throw new Error(result.message);
    } catch (error) {
      if (request === installRequest) {
        updateGlobalState({
          isInstalling: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw error;
    }
  }, [state.status.updateDownloaded]);

  const getAppVersion = useCallback(async () => {
    try {
      const result = await window.electronAPI.getAppVersion();
      return result.version;
    } catch (error) {
      console.error("Failed to get app version:", error);
      return null;
    }
  }, []);

  const clearError = useCallback(() => {
    if (globalState.error) {
      updateGlobalState({ error: null });
    }
  }, []);

  return {
    status: state.status,
    info: state.info,
    downloadProgress: state.downloadProgress,
    isChecking: state.isChecking,
    isDownloading: state.isDownloading,
    isInstalling: state.isInstalling,
    error: state.error,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    getAppVersion,
    clearError,
  };
}
