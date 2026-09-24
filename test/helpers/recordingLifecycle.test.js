const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function recordingHook(cue, start = async () => true, settings = {}) {
  const effects = [];
  const manager = {
    recording: false,
    starts: 0,
    stops: 0,
    cancels: 0,
    getState() {
      return { isRecording: this.recording, isProcessing: false };
    },
    setVoiceAgentRequested() {},
    setTranslationRequested() {},
    setContext() {},
    setCallbacks(callbacks) {
      this.callbacks = callbacks;
    },
    async startRecording() {
      this.starts++;
      await start();
      this.recording = true;
      return true;
    },
    stopRecording() {
      this.stops++;
      this.recording = false;
      return true;
    },
    cancelRecording() {
      this.cancels++;
      this.recording = false;
      return true;
    },
    cleanup() {
      this.recording = false;
    },
  };
  const source = fs.readFileSync(require.resolve("../../src/hooks/useAudioRecording.js"), "utf8");
  const context = {
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
    useTranslation: () => ({ t: (key) => key }),
    AudioManager: function () {
      return manager;
    },
    playStartCue: () => cue,
    playStopCue: () => {},
    getSettings: () => settings,
    expandSnippets: (text) => text,
    isAccessibilitySkipped: () => false,
    performance,
    logger: { info() {} },
    window: { electronAPI: { onToggleDictation() {} } },
    clearTimeout,
  };
  vm.runInNewContext(
    "globalThis.hook = " + source.split("export const useAudioRecording = ")[1],
    context
  );
  const hook = context.hook(() => {});
  const cleanup = effects[0]();
  return { hook, manager, cleanup };
}

test("push release during the start cue prevents microphone recording", async () => {
  const cue = deferred();
  const { hook, manager } = recordingHook(cue.promise);
  const start = hook.startRecording();
  await hook.stopRecording();
  cue.resolve();
  await start;
  assert.equal(manager.starts, 0);
  assert.equal(manager.recording, false);
});

test("push release and cancellation during microphone acquisition are honored", async () => {
  for (const cancel of [false, true]) {
    const acquisition = deferred();
    const entered = deferred();
    const { hook, manager } = recordingHook(Promise.resolve(), () => {
      entered.resolve();
      return acquisition.promise;
    });
    const start = hook.startRecording();
    await entered.promise;
    assert.equal(manager.starts, 1);
    await (cancel ? hook.cancelRecording() : hook.stopRecording());
    acquisition.resolve();
    await start;
    assert.equal(manager.recording, false);
    assert.equal(cancel ? manager.cancels : manager.stops, 1);
  }
});

test("unmount during the cue cannot start a detached recorder", async () => {
  const cue = deferred();
  const { hook, manager, cleanup } = recordingHook(cue.promise);
  const start = hook.startRecording();
  cleanup();
  cue.resolve();
  await start;
  assert.equal(manager.starts, 0);
});

test("cancelling during clipboard placement cannot save into a later recording", async () => {
  const { manager } = recordingHook(Promise.resolve(), undefined, { autoPasteEnabled: true });
  manager._processingGeneration = 1;
  const pasted = deferred();
  manager.safePaste = () => pasted.promise;
  let saved = 0;
  manager.saveTranscription = async () => saved++;
  const completion = manager.callbacks.onTranscriptionComplete({ success: true, text: "old" });
  manager._processingGeneration++;
  pasted.resolve(false);
  await completion;
  assert.equal(saved, 0);
});

function audioMethods() {
  const source = fs.readFileSync(require.resolve("../../src/helpers/audioManager.js"), "utf8");
  const process = source.slice(
    source.indexOf("  async processAudio("),
    source.indexOf("  async processWithLocalWhisper(")
  );
  const cancel = source.slice(
    source.indexOf("  cancelProcessing()"),
    source.indexOf("  async retryLastCloudTranscription(")
  );
  return vm.runInNewContext("({" + process + "," + cancel + "})", {
    performance,
    getLocalSpeechGateDecision: () => ({ skip: false }),
    logger: { info() {}, error() {} },
    VOICELAB_PROVIDER: "voicelab",
    window: { electronAPI: {}, dispatchEvent() {} },
    CustomEvent: class {},
  });
}

for (const failure of [false, true]) {
  test(`a cancelled request's late ${failure ? "failure" : "success"} cannot finish the next transcription`, async () => {
    const manager = audioMethods();
    manager._processingGeneration = 0;
    manager.isProcessing = true;
    const old = deferred(),
      current = deferred(),
      results = [],
      errors = [];
    manager.onTranscriptionComplete = (result) => results.push(result.text);
    manager.onError = (error) => errors.push(error);
    manager.processWithVoiceLabCloud = () => old.promise;
    const first = manager.processAudio(new Blob(["old"]));
    manager.cancelProcessing();
    manager.isProcessing = true;
    manager.processWithVoiceLabCloud = () => current.promise;
    const second = manager.processAudio(new Blob(["new"]));
    if (failure) old.reject(new Error("stale transport error"));
    else old.resolve({ success: true, text: "cancelled", source: "voicelab" });
    await first;
    assert.equal(manager.isProcessing, true);
    assert.deepEqual(results, []);
    assert.deepEqual(errors, []);
    current.resolve({ success: true, text: "current", source: "voicelab" });
    await second;
    assert.deepEqual(results, ["current"]);
    assert.equal(manager.isProcessing, false);
  });
}

test("cancellation while preparing audio prevents a late cloud submission", async () => {
  const source = fs.readFileSync(require.resolve("../../src/helpers/audioManager.js"), "utf8");
  const cloudMethod = source.slice(
    source.indexOf("  async processWithVoiceLabCloud("),
    source.indexOf("  getCustomDictionaryArray(")
  );
  let submissions = 0;
  const manager = vm.runInNewContext("({" + cloudMethod + "})", {
    navigator: { onLine: true },
    getSettings: () => ({}),
    getBaseLanguageCode: () => null,
    window: { electronAPI: { cloudTranscribe: () => submissions++ } },
  });
  manager._processingGeneration = 1;
  manager.getEffectiveSttLanguage = () => "auto";
  const buffer = deferred();
  const request = manager.processWithVoiceLabCloud({ arrayBuffer: () => buffer.promise });
  manager._processingGeneration++;
  buffer.resolve(new ArrayBuffer(1));
  await assert.rejects(request, { code: "CANCELLED" });
  assert.equal(submissions, 0);
});

test("processing remains active until the completion callback finishes", async () => {
  const manager = audioMethods();
  manager._processingGeneration = 0;
  manager.isProcessing = true;
  const completed = deferred();
  const entered = deferred();
  manager.onTranscriptionComplete = async () => {
    entered.resolve();
    await completed.promise;
  };
  manager.processWithVoiceLabCloud = async () => ({ success: true, text: "current" });
  const processing = manager.processAudio(new Blob(["audio"]));
  await entered.promise;
  assert.equal(manager.isProcessing, true);
  completed.resolve();
  await processing;
  assert.equal(manager.isProcessing, false);
});

function methodFromSource(start, end, globals = {}) {
  const source = fs.readFileSync(require.resolve("../../src/helpers/audioManager.js"), "utf8");
  return vm.runInNewContext(
    "({" + source.slice(source.indexOf(start), source.indexOf(end)) + "})",
    {
      logger: { error() {}, warn() {} },
      ...globals,
    }
  );
}

test("microphone acquisition after disposal stops the acquired tracks", async () => {
  const acquired = deferred();
  const entered = deferred();
  let stops = 0;
  const manager = methodFromSource("  async startRecording(", "  async createBatchRecorder(", {
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          entered.resolve();
          return acquired.promise;
        },
      },
    },
  });
  manager.getAudioConstraints = async () => ({});
  manager.captureRecordingAccountId = async () => {};
  const start = manager.startRecording();
  await entered.promise;
  manager._disposed = true;
  acquired.resolve({ getTracks: () => [{ stop: () => stops++ }] });
  assert.equal(await start, false);
  assert.equal(stops, 1);
});

test("cancelled audio assembly cannot submit or replace a newer recording", async () => {
  const manager = methodFromSource("  async finalizeBatchRecording(", "  async replaceBatchMic(");
  manager._processingGeneration = 0;
  manager.micRecovery = { stop() {} };
  manager.teardownSpeechGate = () => {};
  manager.cleanupPreview = async () => null;
  manager.shouldShowPreviewCleanupState = () => false;
  manager._batchSegments = [];
  const merged = deferred();
  manager.mergeRecordedSegments = () => merged.promise;
  let submissions = 0;
  manager.processAudio = async () => submissions++;
  const finish = manager.finalizeBatchRecording({ size: 100 });
  // Cancel, then begin the next recording while the previous WAV is still being assembled.
  manager._processingGeneration++;
  manager.isProcessing = false;
  manager.isRecording = true;
  manager.lastAudioBlob = "new recording";
  merged.resolve({ size: 100 });
  await finish;
  assert.equal(submissions, 0);
  assert.equal(manager.isRecording, true);
  assert.equal(manager.isProcessing, false);
  assert.equal(manager.lastAudioBlob, "new recording");
});

test("discarding a recorder while it stops prevents its late finalization", async () => {
  const manager = methodFromSource(
    "  async finishBatchRecorder(",
    "  async finalizeBatchRecording("
  );
  manager._recordingGeneration = 1;
  const stopped = deferred();
  manager.stopBatchRecorder = () => stopped.promise;
  let finalized = 0;
  manager.finalizeBatchRecording = async () => finalized++;
  const recorder = {};
  manager.wavRecorder = recorder;
  const finish = manager.finishBatchRecorder(recorder);
  manager._recordingGeneration++;
  manager.wavRecorder = "next recorder";
  stopped.resolve({ size: 100 });
  await finish;
  assert.equal(finalized, 0);
  assert.equal(manager.wavRecorder, "next recorder");
});

test("a successful transcription retains its account across a later sign-in", async () => {
  const writes = [];
  const manager = methodFromSource(
    "  async saveTranscription(",
    "  async saveFailedTranscription(",
    {
      getSettings: () => ({ dataRetentionEnabled: true }),
      canonicalProviderName: (provider) => provider,
      VOICELAB_PROVIDER: "voicelab",
      window: { electronAPI: { saveTranscription: async (...args) => writes.push(args) } },
    }
  );
  manager._recordingAccountId = "account-b";
  manager.lastAudioMetadata = { provider: "voicelab", accountId: "account-a" };
  await manager.saveTranscription("account a text");
  assert.equal(writes[0][2].accountId, "account-a");
});

test("a discarded recording retains its captured account while audio is assembled", async () => {
  const manager = methodFromSource(
    "  async persistDiscardedBatchRecording(",
    "  cancelProcessing(",
    {
      getSettings: () => ({}),
      shouldSaveDiscardedRecording: () => true,
    }
  );
  const blob = deferred();
  manager.mergeRecordedSegments = () => blob.promise;
  const accounts = [];
  manager.saveDiscardedTranscription = async (_blob, _duration, accountId) =>
    accounts.push(accountId);
  const save = manager.persistDiscardedBatchRecording({ accountId: "account-a", segments: [] });
  manager._recordingAccountId = "account-b";
  blob.resolve({ size: 100 });
  await save;
  assert.deepEqual(accounts, ["account-a"]);
});

test("disposing an active recorder closes its level meter and preview without finalizing it", async () => {
  const manager = methodFromSource("  cleanup() {", "\n}\n\nexport {");
  let clearedInterval = null;
  const gate = methodFromSource("  teardownSpeechGate()", "  cancelRecording()", {
    clearInterval: (id) => {
      clearedInterval = id;
    },
  });
  Object.assign(manager, gate);
  let closed = 0,
    previews = 0,
    stopped = 0;
  manager._silenceInterval = 7;
  manager._silenceCtx = { close: async () => closed++ };
  manager.emitAudioLevel = () => {};
  manager.cancelProcessing = () => {};
  manager.micRecovery = { stop() {} };
  manager.cleanupPreview = async ({ dismiss }) => {
    if (dismiss) previews++;
  };
  manager.wavRecorder = { state: "recording" };
  manager.stopRecording = () => stopped++;
  manager.getStreamingProvider = () => ({});
  manager.cleanup();
  assert.equal(manager._disposed, true);
  assert.equal(clearedInterval, 7);
  assert.equal(closed, 1);
  assert.equal(previews, 1);
  assert.equal(stopped, 1);
  assert.equal(manager._silenceCtx, null);
});
