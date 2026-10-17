import type { Browser, BrowserContext, Page } from "playwright";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { requestDep } from "@plugins/infra/plugins/deps/server";
import { launchChromium } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  agentOriginHeaders,
  ORIGIN_HEADER,
  ORIGIN_SOURCE_HEADER,
} from "@plugins/infra/plugins/request-origin/core";
import { revertAgentWrites } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import type { BrowserTarget } from "./target";

/**
 * The shared headless browser every agent conversation drives.
 *
 * ONE Chromium per backend — and since MCP is served by the backend that
 * launched the agent (normally main), one for the machine in practice. Each
 * conversation gets its own `BrowserContext` (cookies, storage, viewport), so
 * agents share the process, never the state. Tabs stay alive across tool
 * calls: that is the point — an agent iterates on one failing step instead of
 * relaunching, re-booting the app and replaying the whole flow.
 *
 * Lifetimes are deadlines reset on use, not polling: a session closes after
 * {@link SESSION_IDLE_MS} untouched (and when its conversation ends — see
 * `conversation-ended.ts`), the browser after {@link BROWSER_IDLE_MS} with no
 * session.
 */

const SESSION_IDLE_MS = 10 * 60_000;
const BROWSER_IDLE_MS = 5 * 60_000;
const MAX_TABS = 5;
const LOG_CAP = 500;
const BOUND_MS = 30_000;
/**
 * An action on an element that never becomes actionable (covered, hidden, a
 * stale ref) fails fast: the agent reads why and retries, rather than waiting
 * out a 30 s budget per attempt. Navigation keeps {@link BOUND_MS}.
 */
const ACTION_MS = 5_000;
export const DEFAULT_VIEWPORT = { width: 1400, height: 900 };
/** The request-origin source every request of a drive carries. */
const ORIGIN_SOURCE = "mcp-browser";

export interface ConsoleEntry {
  t: number;
  /** `log` / `warning` / `error` / … — plus `pageerror` and `dialog`. */
  type: string;
  text: string;
}

export interface NetworkEntry {
  t: number;
  method: string;
  url: string;
  status: number | null;
  /** Chromium's error text when the request never got a response. */
  failure: string | null;
}

export interface Tab {
  id: string;
  page: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export interface Session {
  conversationId: string;
  target: BrowserTarget;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  /** The tab a call naming none acts on: the last one used. */
  current: string | null;
  nextTab: number;
  idle: ReturnType<typeof setTimeout> | null;
}

let browser: Promise<Browser> | null = null;
let browserIdle: ReturnType<typeof setTimeout> | null = null;
const sessions = new Map<string, Session>();

/** Not installed yet is an answer, not a wait: ask for it and say so. */
export class BrowserUnavailableError extends Error {}

async function getBrowser(): Promise<Browser> {
  if (browserIdle) {
    clearTimeout(browserIdle);
    browserIdle = null;
  }
  browser ??= launch();
  try {
    return await browser;
  } catch (err) {
    browser = null;
    throw err;
  }
}

async function launch(): Promise<Browser> {
  // The backend never installs (a ~280 MB download on its event loop): it
  // reads, and asks for the install when the browser is not there yet.
  const installed = await readyNow(chromium);
  if (installed.kind === "failed") {
    throw new BrowserUnavailableError(
      `Chromium could not be installed: ${installed.message}. ` +
        "Retry with `./singularity deps install chromium`.",
    );
  }
  if (installed.kind !== "ready") {
    await requestDep(chromium);
    throw new BrowserUnavailableError(
      "Chromium is not installed yet — its install (~280 MB, once per machine) " +
        "was requested. Retry in a minute, or run `./singularity deps install chromium`.",
    );
  }
  const launched = await launchChromium(installed.ready, {
    timeout: BOUND_MS,
    args: [
      "--disable-background-networking",
      "--no-first-run",
      "--disable-sync",
      "--disable-component-update",
    ],
  });
  launched.on("disconnected", () => {
    // Crashed or closed: every session went with it. The next call relaunches
    // and a call naming a lost tab fails loudly with "no tab".
    browser = null;
    for (const s of sessions.values()) if (s.idle) clearTimeout(s.idle);
    sessions.clear();
  });
  return launched;
}

function armBrowserIdle(): void {
  if (sessions.size > 0 || browser === null || browserIdle) return;
  browserIdle = setTimeout(() => {
    browserIdle = null;
    if (sessions.size > 0 || browser === null) return;
    const closing = browser;
    browser = null;
    void runTracked("mcp-browser:close-idle-browser", async () =>
      closeBounded((await closing).close(), "browser"),
    );
  }, BROWSER_IDLE_MS);
}

function touch(session: Session): void {
  if (session.idle) clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    void runTracked("mcp-browser:close-idle-session", () =>
      closeSession(session.conversationId),
    );
  }, SESSION_IDLE_MS);
}

/** The conversation's session, opened (and the browser launched) on first use. */
export async function getSession(
  conversationId: string,
  target: () => Promise<BrowserTarget>,
): Promise<Session> {
  const existing = sessions.get(conversationId);
  if (existing) {
    touch(existing);
    return existing;
  }
  const resolved = await target();
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: DEFAULT_VIEWPORT,
    // Every request is marked as an agent's, so the durable writes a drive
    // makes are attributable and reverted when the session closes.
    extraHTTPHeaders: agentOriginHeaders(ORIGIN_SOURCE),
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(ACTION_MS);
  context.setDefaultNavigationTimeout(BOUND_MS);
  // The headers belong to the target only; strip them from every other origin.
  await context.route(
    (url) => url.origin !== new URL(resolved.origin).origin,
    async (route) => {
      const headers = { ...route.request().headers() };
      delete headers[ORIGIN_HEADER];
      delete headers[ORIGIN_SOURCE_HEADER];
      await route.continue({ headers });
    },
  );
  // A concurrent first call may have opened one meanwhile.
  const raced = sessions.get(conversationId);
  if (raced) {
    await context.close();
    touch(raced);
    return raced;
  }
  const session: Session = {
    conversationId,
    target: resolved,
    context,
    tabs: new Map(),
    current: null,
    nextTab: 1,
    idle: null,
  };
  sessions.set(conversationId, session);
  touch(session);
  return session;
}

/** Open a new tab, recording its console and network from the first request. */
export async function openTab(session: Session): Promise<Tab> {
  if (session.tabs.size >= MAX_TABS) {
    const oldest = session.tabs.keys().next().value;
    if (oldest !== undefined) await closeTab(session, oldest);
  }
  const page = await session.context.newPage();
  const tab: Tab = {
    id: `t${session.nextTab++}`,
    page,
    console: [],
    network: [],
  };
  const push = <T>(log: T[], entry: T) => {
    log.push(entry);
    if (log.length > LOG_CAP) log.shift();
  };
  page.on("console", (m) =>
    push(tab.console, { t: Date.now(), type: m.type(), text: m.text() }),
  );
  page.on("pageerror", (e) =>
    push(tab.console, {
      t: Date.now(),
      type: "pageerror",
      text: e.stack ?? e.message,
    }),
  );
  // A modal dialog blocks every later action; dismiss it and keep a record.
  page.on("dialog", (d) => {
    push(tab.console, {
      t: Date.now(),
      type: "dialog",
      text: `${d.type()}: ${d.message()} (dismissed)`,
    });
    void runTracked("mcp-browser:dismiss-dialog", () => d.dismiss());
  });
  page.on("requestfinished", (req) => {
    void runTracked("mcp-browser:record-request", async () => {
      const res = await req.response();
      push(tab.network, {
        t: Date.now(),
        method: req.method(),
        url: req.url(),
        status: res?.status() ?? null,
        failure: null,
      });
    });
  });
  page.on("requestfailed", (req) => {
    // Chromium reports a beacon / 204 whose response already arrived as
    // ERR_ABORTED; it did not fail (same filter as the harness's capture).
    if (req.timing().responseStart >= 0) return;
    push(tab.network, {
      t: Date.now(),
      method: req.method(),
      url: req.url(),
      status: null,
      failure: req.failure()?.errorText ?? "failed",
    });
  });
  page.on("close", () => {
    session.tabs.delete(tab.id);
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1) ?? null;
    }
  });
  session.tabs.set(tab.id, tab);
  session.current = tab.id;
  return tab;
}

/** The named tab, else the current one; `null` when the session has none. */
export function findTab(session: Session, id?: string): Tab | null {
  const key = id ?? session.current;
  if (key === null) return null;
  const tab = session.tabs.get(key);
  if (!tab) {
    throw new Error(
      `No tab "${key}" in this session (open: ${[...session.tabs.keys()].join(", ") || "none"}). ` +
        "It was closed, or the browser restarted — open one with browser_navigate.",
    );
  }
  session.current = tab.id;
  return tab;
}

export async function closeTab(session: Session, id: string): Promise<void> {
  const tab = session.tabs.get(id);
  if (!tab) throw new Error(`No tab "${id}" in this session.`);
  await closeBounded(tab.page.close(), `tab ${id}`);
}

/**
 * Close a conversation's session: revert the durable writes it made on its
 * target (the same ledger the e2e harness reverts), then drop its context.
 * Returns false when there was none.
 */
export async function closeSession(conversationId: string): Promise<boolean> {
  const session = sessions.get(conversationId);
  if (!session) return false;
  sessions.delete(conversationId);
  if (session.idle) clearTimeout(session.idle);
  try {
    await closeBounded(session.context.close(), "context");
    await revertWrites(session.target);
  } finally {
    armBrowserIdle();
  }
  return true;
}

async function revertWrites(target: BrowserTarget): Promise<void> {
  const res = await fetch(`${target.origin}${revertAgentWrites.path}`, {
    method: revertAgentWrites.method,
    headers: agentOriginHeaders(ORIGIN_SOURCE),
    signal: AbortSignal.timeout(BOUND_MS),
  });
  if (!res.ok) {
    throw new Error(
      `[mcp-browser] reverting agent writes on ${target.origin} failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * A close that never waits forever: `browser.close()` once wedged main's job
 * queue (see prototypes/thumbnails `closeBrowser`). A timed-out close is
 * logged and abandoned — the state is already dropped on this side.
 */
async function closeBounded(p: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BOUND_MS);
  });
  try {
    if ((await Promise.race([p, timeout])) === "timeout") {
      console.error(
        `[mcp-browser] ${what} close did not return within ${BOUND_MS}ms`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
