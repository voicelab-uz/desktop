const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function handlerBlock(source, channel) {
  const start = source.indexOf(`this._handle("${channel}"`);
  assert.notEqual(start, -1, `Expected ${channel} handler`);
  const end = source.indexOf("\n    this._handle(", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test("desktop billing reads only authenticated desktop usage", () => {
  const client = read("src/helpers/voiceLabApiClient.js");
  const ipc = read("src/helpers/ipcHandlers.js");
  const subscription = handlerBlock(ipc, "desktop-subscription");
  const openBilling = handlerBlock(ipc, "open-voicelab-billing");

  assert.match(client, /DESKTOP_USAGE_PATH/);
  assert.match(client, /async getDesktopUsage\(/);
  assert.doesNotMatch(client, /DESKTOP_PRICING_PATH|getDesktopPricing|billing\/desktop\//);
  assert.doesNotMatch(ipc, /this\._handle\("desktop-pricing"/);
  assert.doesNotMatch(read("preload.js"), /desktopPricing/);
  assert.match(subscription, /getDesktopUsage/);
  assert.match(openBilling, /shell\.openExternal/);
  assert.match(openBilling, /getBillingUrl/);
  assert.doesNotMatch(openBilling, /checkout|accessToken|refreshToken/);
});

test("renderer treats entitlement active as authoritative and never infers it from user fields", () => {
  const hook = read("src/hooks/useUsage.ts");

  assert.match(hook, /desktopSubscription/);
  assert.match(hook, /return result\.entitlement\.active/);
  assert.match(hook, /const isSubscribed = entitlement \? entitlement\.active : null/);
  assert.match(
    hook,
    /status: entitlement \? \(entitlement\.active \? "active" : "inactive"\) : "unknown"/
  );
  assert.doesNotMatch(
    hook,
    /subscriptionFromUser|subscription_status|subscriptionStatus|is_subscribed|isSubscribed\s*\?\?/
  );
  assert.doesNotMatch(hook, /\["active", "trial", "trialing"\]/);
});

test("website billing refresh waits for app return and uses bounded documented delays", () => {
  const hook = read("src/hooks/useUsage.ts");
  const main = read("main.js");
  const preload = read("preload.js");

  assert.match(hook, /BILLING_POLL_DELAYS_MS = \[1_000, 2_000, 3_000, 5_000, 8_000\]/);
  assert.match(hook, /billingReturnArmed\.current = true/);
  assert.match(hook, /window\.addEventListener\("focus", refreshAfterBillingReturn\)/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", refreshAfterBillingReturn\)/);
  assert.match(hook, /for \(const delay of BILLING_POLL_DELAYS_MS\)/);
  assert.match(hook, /active === true/);
  assert.match(hook, /openVoiceLabBilling\("desktop"\)/);
  assert.doesNotMatch(hook, /catalog\.enabled === false/);
  assert.match(main, /value === `\$\{OAUTH_PROTOCOL\}:\/\/billing-complete`/);
  assert.doesNotMatch(main, /upgrade-success/);
  assert.match(main, /webContents\.send\("desktop-usage-refresh", \{ reason \}\)/);
  assert.match(preload, /onDesktopUsageRefresh/);
  assert.match(hook, /onDesktopUsageRefresh/);
  assert.match(hook, /loadSubscription\(\{ silent: true \}\)/);
});

test("billing handoff URL contains only the fixed desktop source", () => {
  const client = read("src/helpers/voiceLabApiClient.js");

  assert.match(client, /url\.searchParams\.set\("source", "desktop"\)/);
  assert.doesNotMatch(
    client,
    /searchParams\.set\([^\n]*(?:access|refresh|token|user|plan|credit|payment)/i
  );
});

test("profile usage menu and settings show server plan limits and manual refresh", () => {
  const display = read("src/components/UsageDisplay.tsx");
  const sidebar = read("src/components/ControlPanelSidebar.tsx");
  const hook = read("src/hooks/useUsage.ts");
  const compactStart = display.indexOf("if (compact)");
  const compactEnd = display.indexOf("\n  }\n\n  return (", compactStart);
  const compactDisplay = display.slice(compactStart, compactEnd);

  assert.match(sidebar, /<PopoverContent[\s\S]*side="top"/);
  assert.match(sidebar, /<UsageDisplay surface="profile" autoRefresh=\{open\} usageState=\{usage\} \/>/);
  assert.match(sidebar, /<PopoverContent\s+forceMount/);
  assert.match(display, /usageState\?: UseUsageResult/);
  assert.match(display, /window\.setInterval\(\(\) => void refreshUsage\(\), 10_000\)/);
  assert.match(sidebar, /usedUsagePercentage/);
  assert.doesNotMatch(display, /usage\.plans|planPrice|formatPrice|priceCompact/);
  assert.match(display, /entitlement\.usageLimitSeconds/);
  assert.match(display, /entitlement\?\.resetsAt/);
  assert.match(display, /entitlement\.usedSeconds/);
  assert.match(display, /entitlement\.remainingSeconds/);
  assert.match(display, /usage\.refetch\(\)/);
  assert.match(display, /usage\.hasSubscriptionData && entitlement !== null/);
  assert.match(compactDisplay, /needsEntitlementRefresh[\s\S]*usage\.refetch\(\)/);
  assert.match(compactDisplay, /desktop\.wallet\.noActivePlan/);
  assert.match(compactDisplay, /desktop\.wallet\.choosePlan/);
  assert.doesNotMatch(display, /hourlyLimit|remainingHourCompact|usedThisHour|remainingThisHour/);
  assert.match(display, /disabled=\{!usage\.billingAvailable \|\| usage\.checkoutLoading\}/);
  assert.match(hook, /DESKTOP_USAGE_UPDATED_EVENT/);
  assert.match(hook, /subscriptionRequests\.get\(accountKey\)/);
  assert.match(hook, /loadSubscription\(\{ silent: true \}\)/);
  assert.match(display, /text-2xs/);
});

test("sidebar hides Studio and STT until the product is available", () => {
  const sidebar = read("src/components/ControlPanelSidebar.tsx");

  assert.doesNotMatch(sidebar, /desktop\.nav\.studio/);
  assert.doesNotMatch(sidebar, /desktop\.nav\.stt/);
  assert.doesNotMatch(sidebar, /id: "upload" as const/);
});

test("desktop usage never blocks the authenticated dashboard", () => {
  const router = read("src/AppRouter.jsx");
  const controlPanel = read("src/components/ControlPanel.tsx");

  const authGate = router.indexOf("isControlPanel && authLoaded && !isSignedIn");
  const dashboard = router.indexOf("<ControlPanel");
  assert.ok(authGate > -1 && authGate < dashboard, "authentication must be checked first");
  assert.doesNotMatch(router, /SubscriptionAccessGate/);
  assert.doesNotMatch(controlPanel, /UpgradePrompt|onLimitReached/);
});

test("every locale contains the desktop subscription and plan labels", () => {
  const localeRoot = path.join(root, "src", "locales");
  for (const locale of fs.readdirSync(localeRoot)) {
    const file = path.join(localeRoot, locale, "translation.json");
    if (!fs.existsSync(file)) continue;
    const messages = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(typeof messages.desktop?.nav?.studio, "string", `${locale}: Studio`);
    assert.equal(typeof messages.desktop?.nav?.stt, "string", `${locale}: STT`);
    for (const key of [
      "active",
      "noActivePlan",
      "checking",
      "choosePlan",
      "dailyLimit",
      "resetsOn",
      "refresh",
    ]) {
      assert.equal(typeof messages.desktop?.wallet?.[key], "string", `${locale}: ${key}`);
    }
    assert.equal(typeof messages.desktop?.subscriptionPrompt?.title, "string", locale);
    assert.equal(typeof messages.desktop?.subscriptionPrompt?.limitDescription, "string", locale);
  }
});
