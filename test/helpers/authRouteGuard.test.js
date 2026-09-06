const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("new installations show onboarding before the live reauthentication gate", () => {
  const router = read("src/AppRouter.jsx");

  assert.doesNotMatch(router, /needsReauth|setNeedsReauth/);
  assert.match(router, /isControlPanel && authLoaded && !isSignedIn/);

  const authGate = router.indexOf("isControlPanel && authLoaded && !isSignedIn");
  const onboarding = router.indexOf("isControlPanel && showOnboarding");
  const dashboard = router.indexOf("<ControlPanel initialSettingsSection=");
  assert.ok(
    onboarding > -1 && onboarding < authGate,
    "onboarding must render before the auth gate"
  );
  assert.ok(authGate > -1 && authGate < dashboard, "auth gate must render before dashboard");
});

test("a pending update stays reachable from the sign-in gate", () => {
  const router = read("src/AppRouter.jsx");

  // Update IPC never checks auth state (see registerUpdateIpc.js). Being
  // signed out should never mean losing the only way to reach an update.
  const authGate = router.indexOf("isControlPanel && authLoaded && !isSignedIn");
  const banner = router.indexOf("<UpdateAvailableBanner");
  const authStep = router.indexOf("<AuthenticationStep");
  const nextBranch = router.indexOf("return isControlPanel ? (");
  assert.ok(banner > -1, "the auth gate must render UpdateAvailableBanner");
  assert.ok(
    authGate < banner && banner < authStep && authStep < nextBranch,
    "the banner must render inside the sign-in gate branch, not elsewhere"
  );

  const onboarding = router.slice(
    router.indexOf("isControlPanel && showOnboarding"),
    authGate
  );
  assert.doesNotMatch(
    onboarding,
    /<UpdateAvailableBanner/,
    "onboarding is a first-run flow - nudging a brand-new user to update mid-setup is noise, not the gap this fixes"
  );
});

test("browser sign-in starts only after an explicit user action", () => {
  const authentication = read("src/components/AuthenticationStep.tsx");

  assert.match(authentication, /onClick=\{start\}/);
  assert.doesNotMatch(authentication, /autoStarted|void start\(\)/);
  assert.doesNotMatch(authentication, /authErrorMessage|authErrorRequestId|authErrorFields/);
  assert.match(authentication, /hasStarted/);
  assert.match(authentication, /role="status" aria-live="polite"/);
  assert.match(authentication, /t\("auth\.desktopWaiting"\)/);
});

test("onboarding requires account authorization on its final step", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");

  assert.match(onboarding, /useAuth\(\)/);
  assert.match(onboarding, /step === "ready" \? \(/);
  assert.match(onboarding, /\{!isSignedIn && \(/);
  assert.match(onboarding, /<AuthenticationStep onAuthComplete=\{\(\) => \{\}\} \/>/);
  assert.match(onboarding, /3cf7eb296abc1ebbce4daafaf641a4f0\.jpg/);
  assert.match(onboarding, /grid flex-1 grid-cols-\[minmax\(0,0\.86fr\)_minmax\(0,1\.14fr\)\]/);
  assert.match(onboarding, /className="h-full w-full object-cover"/);
  assert.match(onboarding, /absolute left-1\/2 top-8 z-10 flex -translate-x-1\/2/);
  assert.match(onboarding, /Make every word sound like it belongs\./);
});

test("a newly signed-in user receives a typed greeting before entering the app", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");
  const router = read("src/AppRouter.jsx");
  const greeting = read("src/components/WelcomeGreeting.tsx");
  const styles = read("src/index.css");

  assert.match(onboarding, /introPhase, setIntroPhase/);
  assert.match(onboarding, /setIntroPhase\("mark"\), 500/);
  assert.match(onboarding, /setIntroPhase\("complete"\), 500/);
  assert.match(router, /showWelcomeGreeting/);
  assert.match(router, /<WelcomeGreeting name=\{greetingName\}/);
  assert.match(router, /const handleOnboardingComplete[\s\S]*setShowWelcomeGreeting\(true\)/);
  assert.doesNotMatch(router, /welcomeShownRef/);
  assert.match(greeting, /const EMPTY_BEFORE_MS = 500/);
  assert.match(greeting, /characters\.slice\(0, typedLength\)\.join\(""\)/);
  assert.match(greeting, /const EMPTY_AFTER_MS = 500/);
  assert.match(styles, /@keyframes welcome-greeting-exit/);
  assert.match(styles, /animation: app-content-in 1000ms/);
});

test("macOS accessibility action performs one explicit native request", () => {
  const permissions = read("src/hooks/usePermissions.ts");
  const prompt = permissions.indexOf("promptAccessibilityPermission");
  const settings = permissions.indexOf(
    'openSystemSettings("accessibility", window.electronAPI?.openAccessibilitySettings)',
    prompt
  );

  assert.ok(prompt > -1, "macOS TCC prompt must be requested");
  assert.equal(settings, -1, "the native prompt must not race a second Settings action");
  assert.match(permissions, /if \(accessibilityRequestInFlight\.current\) return/);
});

test("macOS accessibility prompt is only reachable from the explicit permissions action", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const permissions = read("src/hooks/usePermissions.ts");
  const main = read("main.js");

  assert.doesNotMatch(controlPanel, /promptAccessibilityPermission/);
  assert.doesNotMatch(controlPanel, /requestAccessibilityAfterSignIn/);
  assert.doesNotMatch(main, /setTimeout\(checkAndNotifyAccessibility/);
  assert.match(
    permissions,
    /const requestAccessibilityPermission = useCallback[\s\S]*promptAccessibilityPermission/
  );
});

test("macOS activation cannot start a duplicate packaged main-window load", () => {
  const windows = read("src/helpers/windowManager.js");

  assert.match(windows, /this\._mainWindowCreationPromise = null/);
  assert.match(windows, /if \(this\._mainWindowCreationPromise\)/);
  assert.match(windows, /return this\._mainWindowCreationPromise/);
  assert.match(windows, /const creation = this\._createMainWindow\(\)/);
  assert.match(windows, /this\._mainWindowCreationPromise = creation/);

  const promiseGuard = windows.indexOf("if (this._mainWindowCreationPromise)");
  const liveWindowGuard = windows.indexOf("if (this.mainWindow && !this.mainWindow.isDestroyed())");
  assert.ok(promiseGuard > -1 && promiseGuard < liveWindowGuard);

  assert.match(windows, /this\._windowLoadPromises = new WeakMap\(\)/);
  assert.match(windows, /this\._windowLoadPromises\.get\(window\)/);
  assert.match(windows, /this\._controlPanelCreationPromise = null/);
  assert.match(windows, /if \(this\._controlPanelCreationPromise\)/);
});

test("restricted renderer preloads do not call missing dictionary mutation capabilities", () => {
  const settings = read("src/stores/settingsStore.ts");

  assert.match(settings, /const saveDictionary = window\.electronAPI\?\.setDictionary/);
  assert.match(settings, /if \(!saveDictionary\)/);
  assert.doesNotMatch(settings, /electronAPI\s*\n\s*\?\.setDictionary\(words\)/);
});

test("macOS Chromium profile storage never opens the system Keychain", () => {
  const main = read("main.js");
  const electronImport = main.indexOf('} = require("electron")');
  const mockKeychain = main.indexOf('app.commandLine.appendSwitch("use-mock-keychain")');
  const ready = main.indexOf("app.whenReady");

  assert.ok(mockKeychain > electronImport, "switch must be registered after Electron loads");
  assert.ok(ready === -1 || mockKeychain < ready, "switch must be registered before app ready");
});

test("onboarding navigation uses an existing translated common action", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");

  assert.match(onboarding, /t\("common\.next"\)/);
  assert.doesNotMatch(onboarding, /t\("common\.continue"\)/);
});

test("onboarding navigation actions keep one consistent footprint", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");
  const sharedNavClass = /className=\{ONBOARDING_NAV_BUTTON_CLASS\}/g;

  assert.match(onboarding, /const ONBOARDING_NAV_BUTTON_CLASS = "min-w-28"/);
  assert.equal((onboarding.match(sharedNavClass) || []).length, 5);
});

test("onboarding personalizes interface language and appearance without the settings context", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");

  assert.match(onboarding, /ONBOARDING_UI_LANGUAGES/);
  assert.match(onboarding, /value: "uz"/);
  assert.match(onboarding, /value: "en"/);
  assert.match(onboarding, /value: "ru"/);
  assert.match(onboarding, /onClick=\{\(\) => setUiLanguage\(language\.value\)\}/);
  assert.match(onboarding, /onClick=\{\(\) => setTheme\(option\.value\)\}/);
  assert.doesNotMatch(onboarding, /useSettings\(\)/);
  assert.doesNotMatch(onboarding, /WindowControls/);
  assert.doesNotMatch(onboarding, /<header/);
  assert.match(onboarding, /<footer className="[^"]*shrink-0/);
  assert.match(onboarding, /<main className="[^"]*min-h-0/);
});

test("onboarding setup asks only for needed access and saves the chosen shortcut", () => {
  const onboarding = read("src/components/OnboardingFlow.tsx");
  const hotkeyInput = read("src/components/ui/HotkeyInput.tsx");
  const controlPanelPreload = read("preloads/control-panel.js");

  assert.match(onboarding, /platform === "darwin" \? "Fn" : getDefaultHotkey\(\)/);
  assert.match(onboarding, /permissions\.requestMicPermission/);
  assert.match(onboarding, /needsTextInsertionPermission/);
  assert.match(onboarding, /permissions\.requestAccessibilityPermission/);
  assert.match(onboarding, /useSystemAudioPermission/);
  assert.match(onboarding, /canManageSystemAudioInApp\(systemAudio\)/);
  assert.match(onboarding, /systemAudio\.request/);
  assert.doesNotMatch(onboarding, /requestSystemAudioPermission/);
  assert.match(onboarding, /<HotkeyInput/);
  assert.match(onboarding, /variant="onboarding"/);
  assert.doesNotMatch(onboarding, /function ShortcutKeyboard/);
  assert.match(hotkeyInput, /function MacFnKeycap/);
  assert.match(hotkeyInput, /<Globe2/);
  assert.match(onboarding, /role="switch"/);
  assert.match(onboarding, /\(step === "hotkey" && setupPermissionsGranted\)/);
  assert.match(onboarding, /setDictationKey\(value\)/);
  assert.doesNotMatch(onboarding, /onShortcutTested|setShortcutTestMode|isShortcutDetected|ConfettiBurst/);
  assert.doesNotMatch(onboarding, /onDictationComplete/);
  assert.doesNotMatch(onboarding, /Textarea/);
  assert.match(onboarding, /<main className="[^"]*overflow-hidden/);
  assert.doesNotMatch(onboarding, /overflow-y-auto/);
  assert.doesNotMatch(onboarding, /variant="hero"/);

  assert.doesNotMatch(controlPanelPreload, /onShortcutTested|setShortcutTestMode/);
});

test("browser sign-in recovery waits for a confirmed browser launch", () => {
  const auth = read("src/lib/auth.ts");
  const recording = read("src/hooks/useAudioRecording.js");

  assert.match(auth, /function browserSignInStarted/);
  assert.match(auth, /status\.status === "waiting-for-browser"/);
  assert.match(auth, /if \(!browserSignInStarted\(status\)\)/);
  assert.match(recording, /const result = await signInWithSocial\("google"\)/);
  assert.match(recording, /if \(result\.error\)/);
});

test("global error screen keeps internal error details out of the interface", () => {
  const boundary = read("src/components/ErrorBoundary.tsx");

  assert.match(boundary, /componentDidCatch\(error: Error/);
  assert.doesNotMatch(boundary, /this\.state\.error\.message/);
  assert.doesNotMatch(boundary, /<pre/);
});

test("settings keeps both interface and transcription language selectors reachable", () => {
  const modal = read("src/components/SettingsModal.tsx");
  const settings = read("src/components/SettingsPage.tsx");

  assert.match(modal, /CANONICAL_SECTIONS[\s\S]*"general"/);
  assert.match(modal, /id: "general"/);
  assert.doesNotMatch(modal, /general: "speechToText"/);
  assert.match(settings, /value=\{uiLanguage\}/);
  assert.match(settings, /onChange=\{setUiLanguage\}/);
  assert.match(settings, /value=\{preferredLanguage\}/);
  assert.match(settings, /updateTranscriptionSettings\(\{ preferredLanguage: value \}\)/);
});
