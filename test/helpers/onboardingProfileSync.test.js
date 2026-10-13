const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("onboarding answers are saved to the account when the flow finishes", () => {
  const flow = read("src/components/OnboardingFlow.tsx");
  assert.match(flow, /from "\.\.\/helpers\/onboardingProfile"/);
  // finish() clears local progress first, then saves without awaiting so a
  // slow or failed request never blocks the dashboard.
  assert.match(
    flow,
    /clearOnboardingProgress\(\);\s*(?:\/\/[^\n]*\n\s*)*void syncOnboardingProfile\(\);\s*onComplete\(\);/
  );
  // Signing in prefills the remaining steps from an earlier installation.
  assert.match(flow, /desktopOnboardingGet\?\.\(\)/);
  assert.match(flow, /applyOnboardingProfile\(profile\)/);
});

test("the dashboard keeps the profile in sync after onboarding", () => {
  const router = read("src/AppRouter.jsx");
  assert.match(router, /useOnboardingProfileSync\(\{/);
  assert.match(router, /enabled: isControlPanel && isSignedIn && !isLoading && !showOnboarding/);

  const hook = read("src/hooks/useOnboardingProfileSync.ts");
  assert.match(hook, /pullOnboardingProfileOnce\(userId\)/);
  assert.match(hook, /flushPendingOnboardingProfile\(\)/);
  assert.match(hook, /useSettingsStore\.subscribe\(/);
});

test("prefill never overwrites answers already given on this installation", () => {
  const helper = read("src/helpers/onboardingProfile.ts");
  assert.match(helper, /if \(!state\.onboardingRole && profile\.role\)/);
  assert.match(
    helper,
    /languageCode\(state\.preferredLanguage\) === "auto" && profile\.dictationLanguage !== "auto"/
  );
  assert.match(helper, /if \(!writingStyle\(state\) && profile\.writingStyle\)/);
  assert.match(helper, /readStorage\("theme"\) === null/);
  // Failed saves are queued and retried instead of surfacing to the user.
  assert.match(helper, /PENDING_KEY/);
  assert.doesNotMatch(helper, /\bthrow\b/);
});

test("the main process exposes onboarding sync only to the control panel", () => {
  const preload = read("preload.js");
  assert.match(
    preload,
    /desktopOnboardingGet: \(\) => ipcRenderer\.invoke\("desktop-onboarding-get"\)/
  );
  assert.match(
    preload,
    /desktopOnboardingSave: \(profile\) =>\s*ipcRenderer\.invoke\("desktop-onboarding-save", profile\)/
  );

  const generator = read("scripts/generate-preloads.js");
  const controlOnly = generator.slice(
    generator.indexOf("const controlOnly"),
    generator.indexOf("const agent")
  );
  assert.match(controlOnly, /"desktopOnboardingGet"/);
  assert.match(controlOnly, /"desktopOnboardingSave"/);
  assert.doesNotMatch(read("preloads/overlay.js"), /"desktopOnboardingSave"/);
  assert.match(read("preloads/control-panel.js"), /"desktopOnboardingSave"/);

  const ipc = read("src/helpers/ipc/registerAuthIpc.js");
  assert.match(ipc, /handle\("desktop-onboarding-get"/);
  assert.match(
    ipc,
    /handle\("desktop-onboarding-save", async \(_event, profile\) => \{\s*const parsedProfile = parse\(onboardingProfileSchema, profile\);/
  );
  assert.match(ipc, /\.strict\(\)/);
});
