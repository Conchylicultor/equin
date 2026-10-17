import type { Browser, BrowserContext, Page } from "playwright";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { launchChromium } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  agentOriginHeaders,
  ORIGIN_HEADER,
  ORIGIN_SOURCE_HEADER,
} from "@plugins/infra/plugins/request-origin/core";
import {
  MAX_HOST_ERRORS,
  MAX_SESSIONS,
  MAX_TABS,
  type AgentBrowserHostError,
  type AgentBrowserSession,
} from "../core";
import { browserSessionSource, type HostTarget } from "../shared/protocol";
import { revertSessionWrites } from "../shared/revert";

/**
 * The sessions the host holds — the ONE Chromium, a `BrowserContext` per
 * conversation, and each tab's console / network record.
 *
 * Each conversation gets its own context (cookies, storage, viewport), so
 * agents share the process, never the state. Tabs stay alive across tool
 * calls — and, because this lives in the host process rather than the backend,
 * across backend restarts: that is the point. An agent iterates on one failing
 * step instead of relaunching, re-booting the app and replaying the flow.
 *
 * Lifetimes are deadlines reset on use, not polling: a session closes after
 * {@link SESSION_IDLE_MS} untouched (and when its conversation ends — the
 * backend's trigger calls `/close`); the host exits {@link HOST_IDLE_MS} after
 * its last session, taking Chromium with it.
 */

/**
 * Longer than a build: the typical agent loop is look → change → build (~10
 * min, which restarts the backend) → look again, and the tabs must still be
 * there for the second look.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
export const HOST_IDLE_MS = 5 * 60_000;
const LOG_CAP = 500;
const BOUND_MS = 30_000;
/**
 * An action on an element that never becomes actionable (covered, hidden, a
 * stale ref) fails fast: the agent reads why and retries, rather than waiting
 * out a 30 s budget per attempt. Navigation keeps {@link BOUND_MS}.
 */
const ACTION_MS = 5_000;
export const DEFAULT_VIEWPORT = { width: 1400, height: 900 };

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
  /** The main frame's title as of its last navigation or load. */
  title: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export interface Session {
  conversationId: string;
  target: HostTarget;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  /** The tab a call naming none acts on: the last one used. */
  current: string | null;
  nextTab: number;
  openedAt: Date;
  idleDeadline: Date;
  idle: ReturnType<typeof setTimeout> | null;
}

let browser: Promise<Browser> | null = null;
const sessions = new Map<string, Session>();
const errors: AgentBrowserHostError[] = [];
let hostIdleExitAt: Date | null = null;
let hostIdle: ReturnType<typeof setTimeout> | null = null;

/** Wired by the entry: publish the status file, exit when idle. */
let onChange: () => void = () => {};
let onIdle: () => void = () => {};

export function wireHost(hooks: {
  onChange: () => void;
  onIdle: () => void;
}): void {
  onChange = hooks.onChange;
  onIdle = hooks.onIdle;
  armHostIdle();
}

/**
 * Keep a failure the host hit on its own (an idle close, a revert, a dialog
 * dismissal) — nobody is waiting on those to read the error, so it goes into
 * the published status, where the health report shows it, and to stderr.
 */
export function recordHostError(during: string, err: unknown): void {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[agent-browser] ${during}: ${message}`);
  errors.push({ at: new Date().toISOString(), during, message });
  if (errors.length > MAX_HOST_ERRORS) errors.shift();
  onChange();
}

/** Run a piece of background work, keeping its failure. */
function background(during: string, work: () => Promise<unknown>): void {
  work().catch((err: unknown) => recordHostError(during, err));
}

export function hostSnapshot(): {
  idleExitAt: string | null;
  sessions: AgentBrowserSession[];
  errors: AgentBrowserHostError[];
} {
  return {
    idleExitAt: hostIdleExitAt?.toISOString() ?? null,
    sessions: [...sessions.values()].map((s) => ({
      conversationId: s.conversationId,
      origin: s.target.origin,
      openedAt: s.openedAt.toISOString(),
      idleDeadline: s.idleDeadline.toISOString(),
      tabs: [...s.tabs.values()].map((t) => ({
        id: t.id,
        url: t.page.url(),
        title: t.title,
      })),
    })),
    errors: [...errors],
  };
}

async function getBrowser(): Promise<Browser> {
  browser ??= launch();
  try {
    return await browser;
  } catch (err) {
    browser = null;
    throw err;
  }
}

async function launch(): Promise<Browser> {
  // The backend asked for the install before launching this host; reaching
  // here without it is a dependency removed since — say so.
  const installed = await readyNow(chromium);
  if (installed.kind !== "ready") {
    throw new Error(
      `Chromium is not installed (${installed.kind}). Run \`./singularity deps install chromium\`.`,
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
    armHostIdle();
    onChange();
  });
  return launched;
}

function armHostIdle(): void {
  if (sessions.size > 0) {
    if (hostIdle) clearTimeout(hostIdle);
    hostIdle = null;
    hostIdleExitAt = null;
    return;
  }
  if (hostIdle) return;
  hostIdleExitAt = new Date(Date.now() + HOST_IDLE_MS);
  hostIdle = setTimeout(() => {
    hostIdle = null;
    if (sessions.size === 0) onIdle();
  }, HOST_IDLE_MS);
}

function touch(session: Session): void {
  if (session.idle) clearTimeout(session.idle);
  session.idleDeadline = new Date(Date.now() + SESSION_IDLE_MS);
  session.idle = setTimeout(() => {
    background("close-idle-session", () =>
      closeSession(session.conversationId),
    );
  }, SESSION_IDLE_MS);
}

/** The conversation's session, opened (and the browser launched) on first use. */
export async function getSession(
  conversationId: string,
  target: HostTarget,
): Promise<Session> {
  const existing = sessions.get(conversationId);
  if (existing) {
    touch(existing);
    onChange();
    return existing;
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `The agent browser already holds ${MAX_SESSIONS} sessions — close one (browser_close) or wait for an idle one to expire.`,
    );
  }
  const b = await getBrowser();
  const source = browserSessionSource(conversationId);
  const context = await b.newContext({
    viewport: DEFAULT_VIEWPORT,
    // Every request is marked as THIS conversation's, so the durable writes a
    // drive makes are attributable and reverted alone when the session closes.
    extraHTTPHeaders: agentOriginHeaders(source),
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(ACTION_MS);
  context.setDefaultNavigationTimeout(BOUND_MS);
  // The headers belong to the target only; strip them from every other origin.
  await context.route(
    (url) => url.origin !== new URL(target.origin).origin,
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
  const now = new Date();
  const session: Session = {
    conversationId,
    target,
    context,
    tabs: new Map(),
    current: null,
    nextTab: 1,
    openedAt: now,
    idleDeadline: now,
    idle: null,
  };
  sessions.set(conversationId, session);
  touch(session);
  armHostIdle();
  onChange();
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
    title: "",
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
    background("dismiss-dialog", () => d.dismiss());
  });
  page.on("requestfinished", (req) => {
    background("record-request", async () => {
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
  // The status names each tab's url and title; refresh them as the page moves.
  const retitle = () => {
    background("read-title", async () => {
      tab.title = await page.title();
      onChange();
    });
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) retitle();
  });
  page.on("load", retitle);
  page.on("close", () => {
    session.tabs.delete(tab.id);
    if (session.current === tab.id) {
      session.current = [...session.tabs.keys()].at(-1) ?? null;
    }
    onChange();
  });
  session.tabs.set(tab.id, tab);
  session.current = tab.id;
  onChange();
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
 * Close a conversation's session: drop its context, then revert the durable
 * writes IT made on its target — its own request-origin source only, so
 * another conversation's session or an e2e run on the same deploy keeps
 * theirs. Returns false when there was none.
 */
export async function closeSession(conversationId: string): Promise<boolean> {
  const session = sessions.get(conversationId);
  if (!session) return false;
  sessions.delete(conversationId);
  if (session.idle) clearTimeout(session.idle);
  try {
    await closeBounded(session.context.close(), "context");
    await revertSessionWrites(session.target.origin, conversationId);
  } finally {
    armHostIdle();
    onChange();
  }
  return true;
}

/** Close every session (reverting each) and Chromium — the host is leaving. */
export async function closeAll(): Promise<void> {
  for (const id of [...sessions.keys()]) {
    await closeSession(id).catch((err: unknown) =>
      recordHostError(`close-session ${id}`, err),
    );
  }
  const closing = browser;
  browser = null;
  if (closing) await closeBounded((await closing).close(), "browser");
}

/**
 * A close that never waits forever: `browser.close()` once wedged main's job
 * queue (see prototypes/thumbnails `closeBrowser`). A timed-out close is
 * recorded and abandoned — the state is already dropped on this side.
 */
async function closeBounded(p: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BOUND_MS);
  });
  try {
    if ((await Promise.race([p, timeout])) === "timeout") {
      recordHostError(
        `close ${what}`,
        new Error(`did not return within ${BOUND_MS}ms`),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
