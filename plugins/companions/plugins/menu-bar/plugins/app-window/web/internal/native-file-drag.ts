import { useSyncExternalStore } from "react";
import {
  AppWindowInfoSchema,
  FileDragOutcomeSchema,
  WINDOW_BRIDGE_METHODS,
  type EquinWindowBridge,
  type FileDragOutcome,
} from "../../core";

/** Drag host paths out of the window as real files; resolves when it ends. */
export type NativeFileDrag = (
  paths: readonly string[],
) => Promise<FileDragOutcome>;

type ProbeState =
  | { kind: "pending" }
  | { kind: "absent" }
  | { kind: "ready"; fileDrag: NativeFileDrag | null }
  | { kind: "failed"; error: Error };

/** The bridge the helper injected, checked to carry every method — or none. */
function readBridge(): EquinWindowBridge | null {
  const raw: unknown = (window as { equinWindow?: unknown }).equinWindow;
  if (raw === undefined) return null;
  const missing = WINDOW_BRIDGE_METHODS.filter(
    (m) =>
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>)[m] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `window.equinWindow is not the equin bridge: missing ${missing.join(", ")}.`,
    );
  }
  return raw as EquinWindowBridge;
}

// One probe per document: the window and its capabilities do not change while
// the page lives.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the bridge is the document's own (one app window, one page): every surface on it reads the same host
let state: ProbeState | null = null;
const listeners = new Set<() => void>();

function settle(next: ProbeState): void {
  state = next;
  for (const l of listeners) l();
}

function fail(err: unknown, what: string): Error {
  return err instanceof Error ? err : new Error(`${what}: ${String(err)}`);
}

function probe(): ProbeState {
  if (state !== null) return state;
  let bridge: EquinWindowBridge | null;
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
      const parsed = AppWindowInfoSchema.safeParse(raw);
      if (!parsed.success) {
        settle({
          kind: "failed",
          error: new Error(
            `equinWindow.hostInfo() answered an unknown shape: ${parsed.error.message}`,
          ),
        });
        return;
      }
      settle({
        kind: "ready",
        fileDrag: parsed.data.capabilities.fileDrag
          ? async (paths) =>
              FileDragOutcomeSchema.parse(await b.startFileDrag(paths))
          : null,
      });
    },
    (err: unknown) =>
      settle({
        kind: "failed",
        error: fail(err, "equinWindow.hostInfo() failed"),
      }),
  );
  return state;
}

// A server render (a static render to HTML) is no app window: there is no
// window to carry a bridge, and nothing will ever inject one.
const ABSENT: ProbeState = { kind: "absent" };
function serverProbe(): ProbeState {
  return ABSENT;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The installed app window's native file drag, or `null` where there is none
 * — a browser tab, a platform without it, or while the window's `hostInfo()`
 * has not answered yet (the first frames of the page: a drag then is the
 * browser's, which is what a browser tab does anyway). A broken bridge throws
 * here, inside the caller's error boundary.
 */
export function useNativeFileDrag(): NativeFileDrag | null {
  const current = useSyncExternalStore(subscribe, probe, serverProbe);
  if (current.kind === "failed") throw current.error;
  return current.kind === "ready" ? current.fileDrag : null;
}
