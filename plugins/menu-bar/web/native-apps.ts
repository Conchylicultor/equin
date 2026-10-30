import { useEffect, useSyncExternalStore } from "react";
import type { NativeApps } from "../core";
import { useNativeHost } from "./native-host";

/** A pin asked of the helper and not yet in the pinned set: running, or failed with why. */
export type NativePinRequest =
  { state: "pinning" } | { state: "failed"; message: string };

/**
 * The device's installed apps, as the helper keeps them (`apps()`):
 *
 * - `pending` — the helper has not answered yet (its first answer waits for
 *   the sync the panel's own load started);
 * - `unavailable` — no helper, or one that keeps no apps (a plain browser, a
 *   dev tray on another namespace): nothing is installed from here;
 * - `ready` — the installed and pinned app ids, the pins in flight or failed
 *   (by app id), and `pin` (null where the desktop cannot pin);
 * - `error` — the helper failed (its sync or the read), with why.
 *
 * The set is re-read after a pin and each time the panel takes focus (the
 * helper shows it focused and hides it on blur), so an app dragged out of the
 * Dock is heard on the next open.
 */
export type NativeAppsState =
  | { kind: "pending" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      apps: NativeApps;
      requests: ReadonlyMap<string, NativePinRequest>;
      pin: ((appId: string) => Promise<void>) | null;
    }
  | { kind: "error"; error: Error; refresh: () => Promise<void> };

type Read =
  { kind: "ready"; apps: NativeApps } | { kind: "error"; error: Error };

interface Snapshot {
  read: Read | null;
  requests: ReadonlyMap<string, NativePinRequest>;
}

interface Helper {
  apps: () => Promise<NativeApps>;
  pinApp: ((appId: string) => Promise<void>) | null;
}

// One read per document, shared by every surface: the grid and each tile's
// pin read the same answer, and one focus re-reads it once.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the helper is the document's own (one panel window, one page): every surface on it reads the same installed set
let snap: Snapshot = { read: null, requests: new Map() };
// The document's one helper (see above), bound once it answered.
let helper: Helper | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>): void {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

function setRequest(appId: string, request: NativePinRequest | null): void {
  const requests = new Map(snap.requests);
  if (request === null) requests.delete(appId);
  else requests.set(appId, request);
  publish({ requests });
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function refresh(): Promise<void> {
  if (helper === null) return;
  try {
    publish({ read: { kind: "ready", apps: await helper.apps() } });
  } catch (err) {
    publish({ read: { kind: "error", error: asError(err) } });
  }
}

/** Pin through the helper; the outcome is the app's request (then the re-read). */
async function pin(appId: string): Promise<void> {
  const pinApp = helper?.pinApp;
  if (pinApp == null) return;
  setRequest(appId, { state: "pinning" });
  try {
    await pinApp(appId);
    setRequest(appId, null);
  } catch (err) {
    // The panel shows no toasts: the failure rests on the tile.
    setRequest(appId, { state: "failed", message: asError(err).message });
  }
  await refresh();
}

function onFocus(): void {
  void refresh();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(): Snapshot {
  return snap;
}

/** The device's installed and pinned apps (see {@link NativeAppsState}). */
export function useNativeApps(): NativeAppsState {
  const host = useNativeHost();
  const apps = host.kind === "present" ? host.apps : null;
  const pinApp = host.kind === "present" ? host.pinApp : null;
  const current = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    // The host (and so its methods) is one per document: bound once.
    if (apps === null || helper !== null) return;
    helper = { apps, pinApp };
    window.addEventListener("focus", onFocus);
    void refresh();
  }, [apps, pinApp]);
  if (host.kind === "pending") return { kind: "pending" };
  if (apps === null) return { kind: "unavailable" };
  const read = current.read;
  if (read === null) return { kind: "pending" };
  if (read.kind === "error") return { ...read, refresh };
  return {
    kind: "ready",
    apps: read.apps,
    requests: current.requests,
    pin: pinApp === null ? null : pin,
  };
}
