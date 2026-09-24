type NotePatch = { title?: string; content?: string; enhanced_content?: string };

// Own the draft independently of React state so navigation can flush the exact
// latest keystroke, including changes made before React's next render.
export function createDebouncedNoteSaver(
  write: (noteId: number, patch: NotePatch) => Promise<unknown>,
  onError: (error: unknown) => void,
  delay = 1000
) {
  let pending: { noteId: number; patch: NotePatch } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const draft = pending;
    pending = null;
    if (!draft) return Promise.resolve();
    try {
      return Promise.resolve(write(draft.noteId, draft.patch)).then(() => {}, onError);
    } catch (error) {
      onError(error);
      return Promise.resolve();
    }
  };

  return {
    flush,
    hasPending: (noteId: number) => pending?.noteId === noteId,
    schedule(noteId: number, patch: NotePatch) {
      if (pending && pending.noteId !== noteId) void flush();
      pending = { noteId, patch: { ...pending?.patch, ...patch } };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    cancel(noteId: number) {
      if (pending?.noteId !== noteId) return;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
