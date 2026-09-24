import type { DesktopAuthStatus } from "../types/electron";

let scope = "signed-out";
let generation = 0;
const listeners = new Set<() => void>();

function apply(status: DesktopAuthStatus | null | undefined) {
  const id = status?.status === "authenticated" ? status.user?.id : null;
  const next = id ? `account:${id}` : "signed-out";
  if (next === scope) return;
  scope = next;
  generation += 1;
  for (const listener of listeners) listener();
}

// Register before the initial read so a late status response cannot undo logout.
let statusEvents = 0;
if (typeof window !== "undefined") {
  window.electronAPI?.onAuthStateChanged?.((status) => {
    statusEvents += 1;
    apply(status);
  });
}
const initialEvents = statusEvents;
export const accountDataReady =
  typeof window === "undefined"
    ? Promise.resolve()
    : Promise.resolve(window.electronAPI?.authGetStatus?.())
        .then((status) => {
          if (statusEvents === initialEvents) apply(status);
        })
        .catch(() => {});

export function accountDataGeneration() {
  return generation;
}
export function belongsToCurrentAccount(item: unknown): boolean {
  return (
    scope !== "signed-out" && (item as { privacy_scope_id?: string })?.privacy_scope_id === scope
  );
}
export function onAccountDataChanged(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
