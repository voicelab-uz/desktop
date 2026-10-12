import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction } from "../../utils/languageSupport";
import { PROMPT_KINDS, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
  targetLanguageLabel?: string;
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  const custom = useSettingsStore.getState().customPrompts[kind];
  const template = custom || getDefaultPromptText(kind, opts.uiLanguage);
  return applySubstitutions(template, opts, kind);
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];
  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");
  return t(def.i18nKey, { defaultValue: def.fallback });
}

// The cleanup prompt tells the model its input arrives between <transcript>
// tags; the trailing line re-anchors the output contract right after the
// transcript, where models weight instructions most. Mirrors api/reason.ts
// in openwhispr-api.
export function wrapCleanupTranscript(text: string): string {
  return `<transcript>\n${text}\n</transcript>\n\nOutput only the cleaned transcript.`;
}

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string
): string {
  if (!customDictionary?.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const suffix = i18n.getFixedT(locale, "prompts")("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });
  return prompt + suffix + customDictionary.join(", ");
}

function applySubstitutions(
  template: string,
  opts: ResolvePromptOptions,
  kind?: PromptKind
): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  if (opts.targetLanguageLabel) {
    prompt = prompt.replace(/\{\{targetLanguage\}\}/g, opts.targetLanguageLabel);
  }

  const langInstruction = getLanguageInstruction(opts.language);
  if (langInstruction) prompt += "\n\n" + langInstruction;

  if (kind === "cleanup") {
    const styleInstruction = buildWritingStyleInstruction();
    if (styleInstruction) prompt += "\n\n" + styleInstruction;
  }

  return appendDictionarySuffix(prompt, opts.customDictionary, opts.uiLanguage);
}

const WRITING_STYLE_RULES: Record<string, string> = {
  casual: "casual (relaxed punctuation, light capitalization, friendly wording)",
  formal: "formal (complete punctuation, proper capitalization, polished sentences)",
  excited: "excited (energetic wording, exclamation marks where natural)",
};

/**
 * Turns the onboarding writing-style choices into one cleanup instruction.
 * Returns an empty string when the person never picked a style.
 */
export function buildWritingStyleInstruction(): string {
  const state = useSettingsStore.getState();
  const contexts: Array<[string, string]> = [
    ["personal messages", state.writingStylePersonal],
    ["work messages", state.writingStyleWork],
    ["emails", state.writingStyleEmail],
    ["other writing", state.writingStyleOther],
  ];
  const lines = contexts
    .filter(([, style]) => WRITING_STYLE_RULES[style])
    .map(([context, style]) => `- ${context}: ${WRITING_STYLE_RULES[style]}`);
  if (lines.length === 0) return "";
  return (
    "WRITING STYLE: infer the kind of text from its content and apply the matching style while keeping the speaker's meaning:\n" +
    lines.join("\n")
  );
}
