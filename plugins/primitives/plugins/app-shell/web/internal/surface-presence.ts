import { useEffect, useSyncExternalStore } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/** A per-surface "is X drawn here" registry; see {@link defineSurfacePresence}. */
export interface SurfacePresence {
  /** Record that X is drawn on `surfaceId` while the caller is mounted (undefined → nothing). */
  useRecord: Hook<(surfaceId: string | undefined) => void>;
  /** Whether X is drawn on `surfaceId` (a tab id) right now. */
  useDrawnOn: Hook<(surfaceId: string | undefined) => boolean>;
}

/**
 * A registry of which surfaces (tab ids) currently draw some piece of shell
 * chrome: the count of mounted recorders per surface. Derived from what is
 * mounted, never declared by an app, so it cannot disagree with the screen —
 * read by chrome mounted outside every surface tree (the solo launcher, a
 * desktop window's titlebar) about one surface.
 */
export function defineSurfacePresence(): SurfacePresence {
  // Keyed by surface id so surfaces never share an entry; page-global by design
  // (one per registry, held in this closure).
  const drawnOn = new Map<string, number>();
  const listeners = new Set<() => void>();

  const bump = (surfaceId: string, delta: 1 | -1): void => {
    const next = (drawnOn.get(surfaceId) ?? 0) + delta;
    if (next > 0) drawnOn.set(surfaceId, next);
    else drawnOn.delete(surfaceId);
    for (const l of listeners) l();
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  return {
    useRecord: (surfaceId) => {
      useEffect(() => {
        if (surfaceId === undefined) return;
        bump(surfaceId, 1);
        return () => bump(surfaceId, -1);
      }, [surfaceId]);
    },
    useDrawnOn: (surfaceId) => {
      return useSyncExternalStore(
        subscribe,
        () => surfaceId !== undefined && drawnOn.has(surfaceId),
        () => false,
      );
    },
  };
}
