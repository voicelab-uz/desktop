import type { TFunction } from "i18next";
import { KEY_TOKEN } from "./ui";

export type ActivationMode = "tap" | "push";

/**
 * Picks the push-to-talk or tap-to-toggle wording for a shortcut instruction.
 * Keys are resolved as `${base}Hold` / `${base}Tap` so every screen can describe
 * the same gesture consistently.
 */
export function shortcutInstruction(
  t: TFunction,
  base: string,
  mode: ActivationMode,
  shortcut: string
): string {
  return t(`${base}${mode === "push" ? "Hold" : "Tap"}`, { shortcut });
}

/** Same as shortcutInstruction, but leaves a KEY_TOKEN for an inline keycap. */
export function shortcutSentence(t: TFunction, base: string, mode: ActivationMode): string {
  return shortcutInstruction(t, base, mode, KEY_TOKEN);
}
