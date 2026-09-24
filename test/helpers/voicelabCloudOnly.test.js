const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function classMethodContaining(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected source to contain ${marker}`);

  const methodStart = source.lastIndexOf("\n  async ", markerIndex);
  assert.notEqual(methodStart, -1, `Expected ${marker} to be inside an async class method`);

  const nextMethod = source.indexOf("\n  async ", markerIndex + marker.length);
  return source.slice(methodStart, nextMethod === -1 ? source.length : nextMethod);
}

test("desktop speech uses the authenticated synchronous desktop STT contract", () => {
  const client = read("src/helpers/voiceLabApiClient.js");
  const sttRequest = classMethodContaining(client, '"/v1/desktop/stt"');

  assert.match(client, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.match(sttRequest, /authenticatedFetch\("\/v1\/desktop\/stt"/);
  assert.match(sttRequest, /method:\s*"POST"/);
  assert.match(sttRequest, /form\.append\(\s*"audio"/);
  assert.match(sttRequest, /form\.append\(\s*"language"\s*,\s*language\s*\)/);

  assert.doesNotMatch(client, /["'`]\/api\/v1\/stt(?:\/|["'`])/);
  assert.doesNotMatch(client, /stt\/transcriptions|waitForOperation|resumePendingDictations/);
  assert.doesNotMatch(sttRequest, /Idempotency-Key|idempotencyKey|include_speakers/);
  assert.doesNotMatch(client, /\/api\/v1\/desktop\/(wallet|dictation)/);
  assert.doesNotMatch(client, /X-Api-Key|AISHA_API_KEY/);
});

test("desktop STT is one request and is cancellable through IPC", () => {
  const ipcHandlers = read("src/helpers/ipcHandlers.js");
  const preload = read("preload.js");

  assert.doesNotMatch(
    ipcHandlers,
    /CLOUD_INLINE_LIMIT|chunkedCloudTranscribe|resumePendingDesktopDictations/
  );
  assert.doesNotMatch(ipcHandlers, /include_speakers/);

  assert.match(
    preload,
    /cancelCloudTranscribe:\s*\(requestId\)\s*=>[\s\S]*?ipcRenderer\.invoke\("cancel-cloud-transcribe",\s*requestId\)/
  );
  assert.match(ipcHandlers, /this\._handle\("cancel-cloud-transcribe"/);

  const cancelHandler = ipcHandlers.slice(
    ipcHandlers.indexOf('this._handle("cancel-cloud-transcribe"'),
    ipcHandlers.indexOf(
      "\n    this._handle(",
      ipcHandlers.indexOf('this._handle("cancel-cloud-transcribe"') + 1
    )
  );
  assert.match(cancelHandler, /abort|cancel/i);
});

test("desktop release has no local speech runtime or whisper.cpp packaging", () => {
  const releaseSurface = [
    read("main.js"),
    read("preload.js"),
    read("package.json"),
    read("electron-builder.json"),
    read(".github/workflows/build-and-notarize.yml"),
    read(".github/workflows/release-desktop.yml"),
  ].join("\n");

  assert.doesNotMatch(
    releaseSurface,
    /WhisperManager|ParakeetManager|whisper-cpp|whisper-server|download-whisper-cpp/
  );
  assert.equal(fs.existsSync(path.join(root, "scripts", "download-whisper-cpp.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "helpers", "whisper.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "helpers", "parakeet.js")), false);
  assert.doesNotMatch(
    read("src/models/modelRegistryData.json"),
    /whisper\.cpp|ggml-(?:tiny|base|small|medium|large)/
  );

  for (const legacyDownloader of [
    "download-llama-server.js",
    "download-sherpa-onnx.js",
    "download-qdrant.js",
    "download-minilm.js",
    "download-diarization-models.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, "scripts", legacyDownloader)), false);
  }
  assert.equal(fs.existsSync(path.join(root, "resources", "sidecar-manifest.json")), false);
});

test("desktop builds do not download or bundle legacy local AI sidecars", () => {
  const buildSurface = [
    read("package.json"),
    read("electron-builder.json"),
    read(".github/workflows/build-and-notarize.yml"),
    read(".github/workflows/release-desktop.yml"),
  ].join("\n");

  assert.doesNotMatch(buildSurface, /download-(?:llama-server|sherpa-onnx|qdrant)/);
  assert.doesNotMatch(buildSurface, /(?:llama-server|sherpa-onnx|qdrant)-\*/);
  assert.doesNotMatch(buildSurface, /all-MiniLM-L6-v2|diarization-models/);
  assert.doesNotMatch(buildSurface, /@qdrant\/js-client-rest/);
  assert.match(buildSurface, /download-meeting-aec-helper/);
  assert.match(buildSurface, /download-whisper-vad-model/);

  for (const legacyHelper of ["qdrantManager.js", "vectorIndex.js", "localEmbeddings.js"]) {
    assert.equal(fs.existsSync(path.join(root, "src", "helpers", legacyHelper)), false);
  }
});

test("desktop startup cannot initialize legacy local AI runtimes", () => {
  const main = read("main.js");

  assert.doesNotMatch(
    main,
    /require\(["']\.\/src\/helpers\/(?:diarization|qdrantManager|modelManagerBridge|localEmbeddings|vectorIndex)["']\)/
  );
  assert.doesNotMatch(main, /new DiarizationManager\(|new QdrantManager\(|\.prewarmServer\(/);
  assert.doesNotMatch(main, /sidecarRegistry\.register\(["'](?:diarization|llama|qdrant)["']/);

  assert.match(main, /let diarizationManager = null;/);
  assert.match(main, /new IPCHandlers\([\s\S]*?\bdiarizationManager,/);
  assert.match(main, /sidecarRegistry\.register\(["']onnx["']/);
  assert.match(main, /async function startApp\(\) \{\s*reapStaleSidecars\(\);/);
});

test("legacy transcription choices are migrated to VoiceLab Cloud", () => {
  const settingsStore = read("src/stores/settingsStore.ts");
  assert.match(settingsStore, /enforceVoiceLabCloudTranscription\(\)/);
  assert.match(settingsStore, /localStorage\.setItem\(key, "openwhispr"\)/);
  assert.match(settingsStore, /localStorage\.setItem\("useLocalWhisper", "false"\)/);
});

test("runtime provider identities and public transcription sources are VoiceLab-only", () => {
  const audioManager = read("src/helpers/audioManager.js");
  const apiClient = read("src/helpers/voiceLabApiClient.js");
  const reasoningService = read("src/services/ReasoningService.ts");
  const provider = read("src/services/ai/inferenceProviders/voicelab.ts");

  assert.match(audioManager, /source:\s*VOICELAB_PROVIDER/);
  assert.doesNotMatch(audioManager, /processWithOpenWhisprCloud|source:\s*["']openwhispr/);
  assert.match(apiClient, /source:\s*"voicelab"/);
  assert.match(apiClient, /sttProvider:\s*"voicelab"/);
  assert.doesNotMatch(apiClient, /source:\s*["']openwhispr/);

  assert.match(reasoningService, /inferenceProviders\/voicelab/);
  assert.match(provider, /id:\s*"voicelab"/);
  assert.match(provider, /provider:\s*"voicelab"/);
  assert.match(provider, /VOICELAB_(?:START|SUCCESS)/);
  assert.doesNotMatch(provider, /OpenWhispr|OPENWHISPR|openwhispr/);
  assert.equal(
    fs.existsSync(path.join(root, "src", "services", "ai", "inferenceProviders", "openwhispr.ts")),
    false
  );
});

test("renderer preloads expose only the authenticated VoiceLab speech boundary", () => {
  const sources = [read("preload.js")];
  const generatedDir = path.join(root, "preloads");
  for (const name of fs.readdirSync(generatedDir).filter((file) => file.endsWith(".js"))) {
    sources.push(fs.readFileSync(path.join(generatedDir, name), "utf8"));
  }

  const preloadSurface = sources.join("\n");
  for (const capability of [
    "transcribeAudioFile",
    "providerTranscribe",
    "providerTranscribeFile",
    "transcribeLocalWhisper",
    "transcribeLocalParakeet",
    "assemblyAiStreamingStart",
    "deepgramStreamingStart",
    "cortiStreamingStart",
    "dictationRealtimeStart",
    "startDictationPreview",
    "sendDictationPreviewAudio",
  ]) {
    assert.doesNotMatch(preloadSurface, new RegExp(`\\b${capability}\\b`), capability);
  }

  assert.match(preloadSurface, /\bcloudTranscribe\b/);
  assert.match(preloadSurface, /\bcancelCloudTranscribe\b/);
  assert.match(preloadSurface, /\btranscribeAudioFileCloud\b/);
});

test("dictation, retry, meeting, and upload routes are pinned to VoiceLab cloud", () => {
  const audioManager = read("src/helpers/audioManager.js");
  const fileTranscription = read("src/services/fileTranscription.ts");
  const ipcHandlers = read("src/helpers/ipcHandlers.js");

  const processAudio = audioManager.slice(
    audioManager.indexOf("async processAudio("),
    audioManager.indexOf("async processWithLocalWhisper(")
  );
  assert.match(processAudio, /processWithVoiceLabCloud\(audioBlob, metadata, generation\)/);
  assert.doesNotMatch(processAudio, /processWithLocal|processWithOpenAIAPI|providerTranscribe/);
  assert.match(audioManager, /shouldUseStreaming\(_isSignedInOverride\)[\s\S]*?return false;/);

  assert.match(fileTranscription, /transcribeAudioFileCloud/);
  assert.doesNotMatch(fileTranscription, /providerTranscribe|transcribeAudioFile\s*\(/);

  assert.match(ipcHandlers, /DISABLED_LEGACY_SPEECH_CHANNELS/);
  assert.match(ipcHandlers, /meetingLocalMode = true/);
  assert.match(ipcHandlers, /meetingLocalProvider = "voicelab"/);
  assert.match(ipcHandlers, /meetingLocalModel = "voicelab-cloud"/);
  assert.doesNotMatch(
    ipcHandlers,
    /ipcMain\.on\("(?:dictation-realtime-send|dictation-preview-audio|assemblyai-streaming-send|deepgram-streaming-send|corti-streaming-send)"/
  );
  assert.equal(
    fs.existsSync(path.join(root, "src", "helpers", "ipc", "registerProviderIpc.js")),
    false
  );
});
