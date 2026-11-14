/**
 * The extension's popup: frames the equin page (`/home/browser-extension`)
 * and serves its bridge calls with what only an extension has — the tabs and
 * the popup itself. It never calls equin: everything equin does
 * runs inside the frame, same-origin with its server.
 *
 * Bundled by the build (`cli/internal/write-shell.ts`), which writes the equin
 * origin and this shell's digest into `popup.html`. The contract is
 * `core/bridge.ts`.
 */
import {
  BRIDGE_PORT,
  BridgeHelloSchema,
  BridgeRequestSchema,
  type BridgeCall,
  type BridgeResponse,
  type ExtensionHostInfo,
} from "../core/bridge";

/** The part of Chrome's extension API this popup uses. */
interface ChromeTab {
  id?: number;
  url?: string;
  title?: string;
  active: boolean;
  lastAccessed?: number;
}
declare const chrome: {
  tabs: {
    getCurrent(): Promise<ChromeTab | undefined>;
    query(q: { lastFocusedWindow: boolean }): Promise<ChromeTab[]>;
    update(id: number, props: { url: string }): Promise<unknown>;
    create(props: { url: string }): Promise<unknown>;
  };
  runtime: { reload(): void };
};

/** Chrome's own cap on a popup's height. */
const MAX_HEIGHT = 600;

function meta(name: string): string {
  const value = document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content");
  if (!value || value.startsWith("{{"))
    throw new Error(
      `popup.html carries no ${name}: the build did not write it`,
    );
  return value;
}

const origin = meta("equin-origin");
const shellDigest = meta("equin-shell-digest");

const frame = document.createElement("iframe");
frame.src = `${origin}/home/browser-extension?embed=1`;
frame.title = "equin";
document.body.append(frame);

/**
 * The tab the popup is about. Opened from the toolbar the popup is no tab, so
 * it is the active one; opened as a tab of its own (a test, a debugging
 * session), it is the most recently used tab that is not the popup.
 */
async function aboutTab(): Promise<ChromeTab & { id: number }> {
  const self = await chrome.tabs.getCurrent();
  const others = (await chrome.tabs.query({ lastFocusedWindow: true })).filter(
    (t) => t.id !== undefined && t.id !== self?.id,
  );
  const tab =
    others.find((t) => t.active) ??
    [...others].sort(
      (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
    )[0];
  if (tab?.id === undefined) throw new Error("There is no tab to act on.");
  return { ...tab, id: tab.id };
}

const hostInfo: ExtensionHostInfo = {
  version: 1,
  shellDigest,
  capabilities: {
    activeTab: true,
    navigate: true,
    openTab: true,
    close: true,
  },
};

async function answer(call: BridgeCall): Promise<unknown> {
  switch (call.method) {
    case "hostInfo":
      return hostInfo;
    case "activeTab": {
      const tab = await aboutTab();
      return { url: tab.url ?? "", title: tab.title ?? "" };
    }
    case "navigate":
      await chrome.tabs.update((await aboutTab()).id, { url: call.params.url });
      return null;
    case "openTab":
      await chrome.tabs.create({ url: call.params.url });
      return null;
    case "close":
      window.close();
      return null;
    case "setHeight":
      frame.style.height = `${Math.min(call.params.px, MAX_HEIGHT)}px`;
      return null;
    case "reload":
      chrome.runtime.reload();
      return null;
  }
}

async function serve(port: MessagePort, data: unknown): Promise<void> {
  const parsed = BridgeRequestSchema.safeParse(data);
  if (!parsed.success) {
    const id =
      typeof data === "object" && data !== null && "id" in data
        ? Number((data as { id: unknown }).id)
        : -1;
    const refusal: BridgeResponse = {
      id,
      ok: false,
      error: `not a bridge call: ${parsed.error.message}`,
    };
    port.postMessage(refusal);
    return;
  }
  const { id, ...call } = parsed.data;
  let response: BridgeResponse;
  try {
    response = { id, ok: true, value: await answer(call as BridgeCall) };
  } catch (err) {
    response = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  port.postMessage(response);
}

// The page says hello once it listens (a reload says it again); each hello
// from our own frame, at the equin origin, gets a fresh port.
window.addEventListener("message", (event) => {
  const target = frame.contentWindow;
  if (target === null || event.source !== target || event.origin !== origin)
    return;
  if (!BridgeHelloSchema.safeParse(event.data).success) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (m) => void serve(channel.port1, m.data);
  target.postMessage(BRIDGE_PORT, origin, [channel.port2]);
});
