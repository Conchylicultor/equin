import { useSyncExternalStore } from "react";

// The focused app's id — a page-global signal mirroring `focusedSurfaceId`
// (shortcuts) and `surfaceMode` (tabs). Chrome identity (rail highlight, theme
// scope, `:root` tokens) derives from THIS, the focused tab's app — not from
// parsing the URL — so the "theme says app A while content shows app B"
// divergence class becomes structurally impossible. `TabsProvider` publishes it
// on every focus/app change (and boot); the shell history adapter publishes it
// during a back/forward restore, in the same mutation that repoints the focused
// tab — so chrome and content can never race the URL.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: exactly one app is focused per page; mirrors focusedSurfaceId/surfaceMode. Published by the single TabsProvider + the shell history adapter, outside any per-surface tree, so it cannot be a per-surface scoped store.
let focusedAppId: string | undefined;
const listeners = new Set<() => void>();

/** Publish the focused app id (or clear with `undefined`). */
export function setFocusedApp(appId: string | undefined): void {
  if (appId === focusedAppId) return;
  focusedAppId = appId;
  for (const l of listeners) l();
}

export function getFocusedAppId(): string | undefined {
  return focusedAppId;
}

/** Subscribe to focused-app publishes; returns the unsubscribe. */
export function subscribeFocusedApp(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Reactive read of the focused app id, for chrome that must re-render when focus
 * moves between mounted surfaces (rail, tab bar, theme scope). Undefined until
 * `TabsProvider` publishes — callers fall back to URL matching pre-mount.
 */
export function useFocusedAppId(): string | undefined {
  return useSyncExternalStore(
    subscribeFocusedApp,
    getFocusedAppId,
    () => undefined,
  );
}
