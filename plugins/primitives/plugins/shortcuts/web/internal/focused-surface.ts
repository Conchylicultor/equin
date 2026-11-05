// Exactly one surface is focused per page — a legitimately page-global signal,
// read from the window keydown handler (outside any React subtree). It may be a
// surface inside a `<PluginScope>` (the demo's embedded app), so global chrome
// never reads it reactively to resolve data: what a surface says about itself
// reaches chrome through a surface signal (`surface-signal.ts`), which drops an
// entry published from another scope than the reader's.
let focusedSurfaceId: string | undefined;
const listeners = new Set<() => void>();

export function setFocusedSurfaceId(id: string | undefined): void {
  if (id === focusedSurfaceId) return;
  focusedSurfaceId = id;
  for (const l of listeners) l();
}

export function getFocusedSurfaceId(): string | undefined {
  return focusedSurfaceId;
}

/** Subscribe to focus changes (returns an unsubscribe). Package-internal: surface signals. */
export function subscribeFocusedSurface(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
