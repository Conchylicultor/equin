import { useSyncExternalStore } from "react";
import {
  BRIDGE_METHODS,
  NativeHostInfoSchema,
  type EquinNativeBridge,
  type NativeCapabilities,
  type NativeHostInfo,
  type NativeMaterial,
  type NativeNotification,
} from "../core";

/**
 * The native helper hosting this page, as the panel's sections read it:
 *
 * - `pending` — the bridge exists, and `hostInfo()` has not answered yet;
 * - `absent` — no helper: the page is open in a browser (or an app window,
 *   which gets no bridge). Sections fall back to plain web behaviour;
 * - `present` — the helper's platform, capabilities and methods.
 *
 * A capability the host lacks has no method to call: its slot is `null`, so a
 * section cannot reach for what the platform does not have — it hides the UI.
 */
export type NativeHost =
  | { kind: "pending" }
  | { kind: "absent" }
  | {
      kind: "present";
      platform: "macos" | "linux";
      capabilities: NativeCapabilities;
      /** The window is a transparent material the page must not cover. */
      material: NativeMaterial | null;
      notify: ((n: NativeNotification) => Promise<void>) | null;
      setAttention: ((on: boolean) => Promise<void>) | null;
      openUrl: ((url: string) => Promise<void>) | null;
      launchApp: ((appId: string) => Promise<void>) | null;
      hidePanel: () => Promise<void>;
      setPanelHeight: (px: number) => Promise<void>;
    };

type ProbeState = NativeHost | { kind: "failed"; error: Error };

/** The bridge the helper injected, checked to carry every method — or none. */
function readBridge(): EquinNativeBridge | null {
  const raw: unknown = (window as { equinNative?: unknown }).equinNative;
  if (raw === undefined) return null;
  const missing = BRIDGE_METHODS.filter(
    (m) =>
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>)[m] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `window.equinNative is not the equin bridge: missing ${missing.join(", ")}.`,
    );
  }
  return raw as EquinNativeBridge;
}

function presentHost(
  bridge: EquinNativeBridge,
  info: NativeHostInfo,
): NativeHost {
  const caps = info.capabilities;
  return {
    kind: "present",
    platform: info.platform,
    capabilities: caps,
    material: info.material,
    notify: caps.notify ? (n) => bridge.notify(n) : null,
    setAttention: caps.attention ? (on) => bridge.setAttention(on) : null,
    openUrl: caps.openUrl ? (url) => bridge.openUrl(url) : null,
    launchApp: caps.launchApp ? (id) => bridge.launchApp(id) : null,
    hidePanel: () => bridge.hidePanel(),
    setPanelHeight: (px) => bridge.setPanelHeight(px),
  };
}

// One probe per document: the helper and its capabilities do not change while
// the page lives, so every section shares the one `hostInfo()` answer.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the bridge is the document's own (one helper window, one page): every surface on it reads the same host
let state: ProbeState | null = null;
const listeners = new Set<() => void>();

function settle(next: ProbeState): void {
  state = next;
  for (const l of listeners) l();
}

function probe(): ProbeState {
  if (state !== null) return state;
  let bridge: EquinNativeBridge | null;
  try {
    bridge = readBridge();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    state = { kind: "failed", error: err };
    return state;
  }
  if (bridge === null) {
    state = { kind: "absent" };
    return state;
  }
  state = { kind: "pending" };
  const b = bridge;
  b.hostInfo().then(
    (raw) => {
      const parsed = NativeHostInfoSchema.safeParse(raw);
      settle(
        parsed.success
          ? presentHost(b, parsed.data)
          : {
              kind: "failed",
              error: new Error(
                `equinNative.hostInfo() answered an unknown shape: ${parsed.error.message}`,
              ),
            },
      );
    },
    (err: unknown) =>
      settle({
        kind: "failed",
        error:
          err instanceof Error
            ? err
            : new Error(`equinNative.hostInfo() failed: ${String(err)}`),
      }),
  );
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The native helper hosting this page (see {@link NativeHost}). A broken
 * bridge — methods missing, `hostInfo()` rejecting or answering an unknown
 * shape — throws here, so the section reading it crashes inside its own error
 * boundary instead of guessing at a host it cannot trust.
 */
export function useNativeHost(): NativeHost {
  const current = useSyncExternalStore(subscribe, probe);
  if (current.kind === "failed") throw current.error;
  return current;
}
