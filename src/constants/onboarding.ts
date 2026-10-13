export const ONBOARDING_FLOW_VERSION = 4;
export const ONBOARDING_STEP_KEY = `voicelab:onboarding-step:v${ONBOARDING_FLOW_VERSION}`;

export const ONBOARDING_STEPS = [
  "welcome",
  "signin",
  "about-you",
  "typing-places",
  "permissions",
  "mic-test",
  "shortcut",
  "language",
  "try-it-intro",
  "try-it-message",
  "try-it-email",
  "try-it-list",
  "time-savings",
  "personalize",
  "finish",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_SECTIONS = [
  { id: "getStarted", steps: ["welcome", "signin", "about-you", "typing-places"] },
  { id: "permissions", steps: ["permissions"] },
  { id: "setUp", steps: ["mic-test", "shortcut", "language"] },
  {
    id: "learn",
    steps: ["try-it-intro", "try-it-message", "try-it-email", "try-it-list", "time-savings"],
  },
  {
    id: "personalize",
    steps: ["personalize", "finish"],
  },
] as const satisfies readonly { id: string; steps: readonly OnboardingStep[] }[];

export type OnboardingSectionId = (typeof ONBOARDING_SECTIONS)[number]["id"];

export function sectionIndexForStep(step: OnboardingStep): number {
  const index = ONBOARDING_SECTIONS.findIndex((section) =>
    (section.steps as readonly OnboardingStep[]).includes(step)
  );
  return Math.max(0, index);
}

// Earlier flows stored progress under these keys. Their step names no longer
// exist, so any saved value simply restarts the new flow from the beginning.
const LEGACY_ONBOARDING_STEP_KEYS = [
  "onboardingCurrentStep",
  "voicelab:onboarding-step:v2",
  "voicelab:onboarding-step:v3",
];

function hasLegacyProgress(): boolean {
  return LEGACY_ONBOARDING_STEP_KEYS.some((key) => localStorage.getItem(key) !== null);
}

function clearLegacyProgress(): void {
  for (const key of LEGACY_ONBOARDING_STEP_KEYS) localStorage.removeItem(key);
}

export function readOnboardingStep(): OnboardingStep {
  const saved = localStorage.getItem(ONBOARDING_STEP_KEY) as OnboardingStep | null;
  if (saved && ONBOARDING_STEPS.includes(saved)) return saved;

  const migrated: OnboardingStep = "welcome";
  if (hasLegacyProgress()) {
    localStorage.setItem(ONBOARDING_STEP_KEY, migrated);
    clearLegacyProgress();
  }
  return migrated;
}

export function hasOnboardingProgress(): boolean {
  if (localStorage.getItem(ONBOARDING_STEP_KEY)) return true;
  if (!hasLegacyProgress()) return false;
  readOnboardingStep();
  return true;
}

export function clearOnboardingProgress(): void {
  localStorage.removeItem(ONBOARDING_STEP_KEY);
  clearLegacyProgress();
}
