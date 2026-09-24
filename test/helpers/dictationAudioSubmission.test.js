const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the start cue completes before microphone recording starts", () => {
  const source = read("src/hooks/useAudioRecording.js");
  const startFlow = source.slice(
    source.indexOf("const performStartRecording"),
    source.indexOf("const performStopRecording")
  );

  assert.ok(startFlow.indexOf("await playStartCue();") >= 0);
  assert.ok(
    startFlow.indexOf("await playStartCue();") < startFlow.indexOf("manager.startRecording()")
  );
});

test("the start cue uses the bundled voice sound and waits through it", () => {
  const source = read("src/utils/dictationCues.js");

  assert.match(source, /assets\/audios\/voice\.wav/);
  assert.match(source, /playAudioCue\("voice", \{ waitForCompletion: true \}\)/);
  assert.match(source, /await completion/);
});

test("all locally detected non-speech is rejected before cloud upload", () => {
  const source = read("src/helpers/audioManager.js");
  const processAudio = source.slice(
    source.indexOf("async processAudio(audioBlob"),
    source.indexOf("async processWithLocalWhisper")
  );

  assert.match(processAudio, /if \(speechGateDecision\.skip\)/);
  assert.ok(
    processAudio.indexOf("if (speechGateDecision.skip)") <
      processAudio.indexOf("this.processWithVoiceLabCloud")
  );
});

test("recoverable desktop STT failures retain audio, while final success releases it", () => {
  const source = read("src/helpers/audioManager.js");
  const processAudio = source.slice(
    source.indexOf("async processAudio(audioBlob"),
    source.indexOf("async processWithLocalWhisper")
  );
  const saveTranscription = source.slice(
    source.indexOf("async saveTranscription("),
    source.indexOf("async saveFailedTranscription")
  );

  assert.doesNotMatch(processAudio, /isAuthenticationFailure[\s\S]*lastAudioBlob = null/);
  assert.match(processAudio, /if \(this\.lastAudioBlob\) \{\s*this\.lastRetryMetadata = metadata/);
  assert.match(saveTranscription, /provider !== VOICELAB_PROVIDER/);
  assert.match(saveTranscription, /finally[\s\S]*provider === VOICELAB_PROVIDER/);
  assert.match(saveTranscription, /this\.lastAudioBlob === capturedAudioBlob/);
  assert.match(source, /if \(this\.lastAudioBlob && this\.lastRetryMetadata\)/);
});

test("desktop recovery UI has no local transcription fallback", () => {
  const source = read("src/utils/recordingErrors.ts");
  const hook = read("src/hooks/useAudioRecording.js");

  assert.doesNotMatch(source, /RecordingRecoveryAction = [^\n]*"local"/);
  assert.doesNotMatch(source, /VOICELAB_STREAMING_DISABLED/);
  assert.doesNotMatch(source, /Use local|Lokal rejim|Локальный режим/);
  assert.doesNotMatch(hook, /recovery === "local"|setUseLocalWhisper/);
});

test("paste permission failures provide an explicit Settings recovery action", () => {
  const source = read("src/utils/recordingErrors.ts");
  const hook = read("src/hooks/useAudioRecording.js");

  assert.match(source, /PASTE_ACCESSIBILITY_REQUIRED["']\) return "permission"/);
  assert.match(source, /permission: "Sozlamalarni ochish"/);
  assert.match(hook, /recovery === "permission"[\s\S]*openAccessibilitySettings/);
});
