import { useSyncExternalStore } from "react";
import {
  acceptBridgePort,
  BRIDGE_HELLO,
  BRIDGE_RESULTS,
  BridgeResponseSchema,
  EXTENSION_ORIGIN,
  type ActiveTab,
  type BridgeCall,
  type BridgeResult,
  type ExtensionHostInfo,
} from "../core";

/**
 * The extension hosting this page, as the panel's sections read it:
 *
 * - `pending` — the page is framed by the extension's popup, which has not
 *   answered yet;
 * - `absent` — no extension: the page is open in a plain tab (or framed by
 *   anything else). The route says it runs inside the extension;
 * - `present` — the shell's info, the tab the popup is about (`null` when
 *   the shell cannot read it), and its methods — a capability the shell lacks
 *   has no method.
 */
export type ExtensionHost =
  | { kind: "pending" }
  | { kind: "absent" }
  | {
      kind: "present";
      info: ExtensionHostInfo;
      tab: ActiveTab | null;
      navigate: ((url: string) => Promise<void>) | null;
      openTab: ((url: string) => Promise<void>) | null;
      close: (() => Promise<void>) | null;
      setAttention: ((on: boolean) => Promise<void>) | null;
      setHeight: (px: number) => Promise<void>;
      reload: () => Promise<void>;
    };

type ProbeState = ExtensionHost | { kind: "failed"; error: Error };

type Call = <C extends BridgeCall>(
  call: C,
) => Promise<BridgeResult<C["method"]>>;

/** A client over the bridge port: each call answered by its id, parsed. */
function bridgeClient(port: MessagePort): Call {
  let nextId = 0;
  const waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  port.onmessage = (event: MessageEvent<unknown>) => {
    const response = BridgeResponseSchema.parse(event.data);
    const entry = waiting.get(response.id);
    if (entry === undefined)
      throw new Error(`bridge answered an unknown call #${response.id}`);
    waiting.delete(response.id);
    if (response.ok) entry.resolve(response.value);
    else entry.reject(new Error(response.error));
  };
  return async (call) => {
    const id = nextId++;
    const value = await new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      port.postMessage({ id, ...call });
    });
    // The schema is the method's own, so its output is that method's result.
    return BRIDGE_RESULTS[call.method].parse(value) as BridgeResult<
      (typeof call)["method"]
    >;
  };
}

async function presentHost(call: Call): Promise<ExtensionHost> {
  const info = await call({ method: "hostInfo", params: {} });
  const caps = info.capabilities;
  const tab = caps.activeTab
    ? await call({ method: "activeTab", params: {} })
    : null;
  const done = async (p: Promise<null>) => {
    await p;
  };
  return {
    kind: "present",
    info,
    tab,
    navigate: caps.navigate
      ? (url) => done(call({ method: "navigate", params: { url } }))
      : null,
    openTab: caps.openTab
      ? (url) => done(call({ method: "openTab", params: { url } }))
      : null,
    close: caps.close
      ? () => done(call({ method: "close", params: {} }))
      : null,
    setAttention: caps.attention
      ? (on) => done(call({ method: "setAttention", params: { on } }))
      : null,
    setHeight: (px) => done(call({ method: "setHeight", params: { px } })),
    reload: () => done(call({ method: "reload", params: {} })),
  };
}

// One probe per document: the popup frames the page once, and every section
// shares its one answer.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- the bridge is the document's own (one popup, one page): every surface on it reads the same host
let state: ProbeState | null = null;
const listeners = new Set<() => void>();

function settle(next: ProbeState): void {
  state = next;
  for (const l of listeners) l();
}

function failed(err: unknown): ProbeState {
  return {
    kind: "failed",
    error: err instanceof Error ? err : new Error(String(err)),
  };
}

/** Whether the extension's popup is this page's parent. */
function framedByExtension(): boolean {
  if (window.parent === window) return false;
  return window.location.ancestorOrigins.item(0) === EXTENSION_ORIGIN;
}

function probe(): ProbeState {
  if (state !== null) return state;
  if (!framedByExtension()) {
    state = { kind: "absent" };
    return state;
  }
  state = { kind: "pending" };
  const onMessage = (event: MessageEvent<unknown>) => {
    const port = acceptBridgePort(
      {
        origin: event.origin,
        source: event.source,
        data: event.data,
        ports: event.ports,
      },
      window.parent,
    );
    if (port === null) return;
    window.removeEventListener("message", onMessage);
    presentHost(bridgeClient(port)).then(settle, (err: unknown) =>
      settle(failed(err)),
    );
  };
  window.addEventListener("message", onMessage);
  // Listening now: ask the popup for the port (to its origin only).
  window.parent.postMessage(BRIDGE_HELLO, EXTENSION_ORIGIN);
  return state;
}

// A server render is hosted by no extension.
const ABSENT: ProbeState = { kind: "absent" };
function serverProbe(): ProbeState {
  return ABSENT;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The extension hosting this page (see {@link ExtensionHost}). A broken
 * bridge — a call refused, an answer of an unknown shape — throws here, so the
 * section reading it crashes inside its own error boundary instead of guessing.
 */
export function useExtensionHost(): ExtensionHost {
  const current = useSyncExternalStore(subscribe, probe, serverProbe);
  if (current.kind === "failed") throw current.error;
  return current;
}
