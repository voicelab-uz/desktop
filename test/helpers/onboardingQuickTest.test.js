const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("publishes completed cloud dictation before the optional preview guard", () => {
  const source = read("src/helpers/ipcHandlers.js");
  const handler = source.slice(
    source.indexOf('this._handle("complete-dictation-preview"'),
    source.indexOf('this._handle("hide-dictation-preview"')
  );

  assert.match(
    handler,
    /this\.broadcastToWindows\("dictation-complete", \{\s*text: completedText,\s*durationMs: completedDurationMs,\s*\}\)/
  );
  assert.ok(
    handler.indexOf('this.broadcastToWindows("dictation-complete"') <
      handler.indexOf("if (!dictationPreviewSessionActive)")
  );
});

test("exposes completed dictation to the control panel without an onboarding shortcut test mode", () => {
  const preload = read("preload.js");
  const generator = read("scripts/generate-preloads.js");
  const onboarding = read("src/components/OnboardingFlow.tsx");

  assert.match(preload, /onDictationComplete: registerListener\(\n[ ]{4}"dictation-complete"/);
  assert.match(generator, /"onDictationComplete",/);
  assert.doesNotMatch(generator, /"setShortcutTestMode",/);
  assert.doesNotMatch(generator, /"onShortcutTested",/);
  assert.doesNotMatch(onboarding, /setShortcutTestMode|onShortcutTested|isShortcutDetected/);
});
