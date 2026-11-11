import { useCallback, useSyncExternalStore } from "react";

/**
 * Optimistic overlay of each song's `groovePresetId`, between a commit and the
 * `rhythms` row push that carries it.
 *
 * The patterns already have an optimistic home (the shell's `grooveSetting`),
 * but the preset id is this plugin's own column, so without an overlay "Apply
 * preset" would read the row's OLD id until the push lands — the preset
 * button would flash "edited" (the new content measured against the old
 * preset). Module-level, keyed by song, so the section body and its header switch
 * (two `useGroove()` mounts) read one overlay, and a commit from either carries
 * the other's latest id.
 *
 * An entry leaves only when the row reports the SAME id (`confirmPendingPreset`),
 * never on a timer; a failed save leaves it in place (the global error toast is
 * the failure surface — a pending edit is never visually reverted).
 */
const pending = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** No overlay for this song: read the row. Distinct from a pending `null`. */
export const NO_PENDING_PRESET: unique symbol = Symbol("no-pending-preset");
export type PendingPreset = string | null | typeof NO_PENDING_PRESET;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record the preset id a commit just sent for `songId`. */
export function setPendingPreset(
  songId: string,
  presetId: string | null,
): void {
  pending.set(songId, presetId);
  emit();
}

/**
 * Drop `songId`'s overlay once the row carries `confirmed` — only when it is
 * the id last sent, so an older push cannot evict a newer commit's id.
 */
export function confirmPendingPreset(
  songId: string,
  confirmed: string | null,
): void {
  if (!pending.has(songId) || pending.get(songId) !== confirmed) return;
  pending.delete(songId);
  emit();
}

/** The overlaid preset id for `songId`, or `NO_PENDING_PRESET`. */
export function usePendingPreset(songId: string | null): PendingPreset {
  const getSnapshot = useCallback(
    (): PendingPreset =>
      songId !== null && pending.has(songId)
        ? (pending.get(songId) ?? null)
        : NO_PENDING_PRESET,
    [songId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
