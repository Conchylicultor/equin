import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { launchChromium } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  agentOriginHeaders,
  ORIGIN_HEADER,
  ORIGIN_SOURCE_HEADER,
} from "@plugins/infra/plugins/request-origin/core";
import {
  GATEWAY_PORT,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";
import {
  MAX_HOST_ERRORS,
  MAX_SESSIONS,
  MAX_TABS,
  type AgentBrowserHostError,
  type AgentBrowserSession,
} from "../core";
import { browserSessionSource, type HostTarget } from "../shared/protocol";
import { revertSessionWritesOn } from "../shared/revert";
import { trackWrites, type WriteDrain } from "./write-drain";

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
 * its last session, taking Chromium with it. "Use" is a tool call (and, for a
 * bounded time after `browser_attach`, the traffic of the script it hands a
 * tab to) — never a page's own traffic: an app keeps fetching on its own (a
 * live socket, telemetry posts), and counting that kept every session that had
 * one of our apps open alive forever.
 *
 * Between calls a session's tabs are frozen (see {@link FREEZE_AFTER_MS}).
 */

/**
 * Longer than a build: the typical agent loop is look → change → build (~10
 * min, which restarts the backend) → look again, and the tabs must still be
 * there for the second look.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
export const HOST_IDLE_MS = 5 * 60_000;
/**
 * A tab renders only while an agent uses it. Headless Chromium has no GPU, so
 * every frame a page draws is rasterized on the CPU (SwiftShader) — and a page
 * that redraws forever (a WebGL canvas on a ticker, a CSS spinner) costs whole
 * cores with nobody looking: four idle Sonata tabs once held ~4.5 cores for
 * hours. So once no call has touched a session for this long, its tabs are
 * frozen, and the next call thaws them before it runs. Long enough that an
 * agent reading a result and deciding its next step does not freeze and thaw
 * between calls.
 *
 * Frozen = the page's JavaScript paused in the debugger (`Debugger.pause`; a
 * thaw is `Debugger.disable`, which resumes it, or cancels a pause still
 * pending on a page that ran no JS since). No script runs, so no rAF draws a
 * frame: measured, an idle Sonata song's GPU process fell from ~60 % to 0.
 * `Page.setWebLifecycleState: frozen` is NOT it — headless pages are always
 * visible, and Chromium ignores a freeze of a visible page (scripts kept
 * running, the GPU cost was unchanged); a minimized window is ignored too.
 */
export const FREEZE_AFTER_MS = 60_000;
/**
 * How long a `browser_attach` ticket keeps its session rendering and counts
 * its pages' traffic as use: an e2e script drives the tab without one MCP
 * call, and must be neither frozen nor idle-closed mid-run. Bounded, because
 * the host cannot see the script end — a session holds it at most this long
 * after its last attach.
 */
export const SCRIPT_HOLD_MS = 30 * 60_000;
const LOG_CAP = 500;
const BOUND_MS = 30_000;
/**
 * How long closing waits for a session's in-flight writes before reverting
 * anyway: a localhost write answers in milliseconds, so one still open after
 * this is stuck, and must not keep the user's data changed.
 */
const DRAIN_MS = 10_000;
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
  /** Paused between calls ({@link FREEZE_AFTER_MS}); resumed by the next. */
  frozen: boolean;
  /** The page's own CDP session, opened on its first freeze. */
  cdp: Promise<CDPSession> | null;
}

export interface Session {
  conversationId: string;
  /** Where routes resolve — the latest call's, so a build since takes effect. */
  target: HostTarget;
  /**
   * Every deploy a request of this session reached, stamped with its
   * agent-origin headers: where its writes may be, so what closing reverts.
   */
  origins: Set<string>;
  context: BrowserContext;
  /** Its writes still on the wire, which closing waits for before reverting. */
  writes: WriteDrain;
  tabs: Map<string, Tab>;
  /** The tab a call naming none acts on: the last one used. */
  current: string | null;
  nextTab: number;
  openedAt: Date;
  idleDeadline: Date;
  idle: ReturnType<typeof setTimeout> | null;
  /** Freezes the tabs {@link FREEZE_AFTER_MS} after the last call ended. */
  freeze: ReturnType<typeof setTimeout> | null;
  /** Set while a script attached through `browser_attach` may be driving a tab. */
  scriptHold: ReturnType<typeof setTimeout> | null;
}

let browser: Promise<Browser> | null = null;
const sessions = new Map<string, Session>();
const errors: AgentBrowserHostError[] = [];
let hostIdleExitAt: Date | null = null;
let hostIdle: ReturnType<typeof setTimeout> | null = null;
/** Each launched browser's `bind()` pipe, opened on the first attach ticket. */
const bound = new WeakMap<Browser, Promise<string>>();
/** The tab a page is, so the context's `page` event and `openTab` adopt it once. */
const tabOfPage = new WeakMap<Page, Tab>();

/**
 * Tool calls running per conversation — keyed by id, not session, because a
 * conversation's first call runs before its session exists.
 */
const callsInFlight = new Map<string, number>();
/**
 * One freeze or thaw at a time per conversation: a thaw racing a freeze still
 * in progress would skip the tab the freeze then marks frozen, and the call
 * would act on a page that runs nothing.
 */
const lifecycle = createKeyedMutex();

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
      target: s.target.kind === "deploy" ? s.target.origin : null,
      origins: [...s.origins],
      openedAt: s.openedAt.toISOString(),
      idleDeadline: s.idleDeadline.toISOString(),
      tabs: [...s.tabs.values()].map((t) => ({
        id: t.id,
        url: t.page.url(),
        title: t.title,
        frozen: t.frozen,
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
    for (const s of sessions.values()) clearTimers(s);
    sessions.clear();
    armHostIdle();
    onChange();
  });
  return launched;
}

/**
 * The shared browser's pipe endpoint, for an e2e script to `chromium.connect`
 * to. `bind()` serves connections in Playwright's shared-browser mode: each one
 * sees every context and page, and leaves them open when it disconnects — so a
 * script drives a tab of this conversation's own session and the tab outlives
 * the script. Bound lazily (most browsers never see a script) and once per
 * launch; the pipe dies with the browser.
 */
export async function bindEndpoint(): Promise<string> {
  const b = await getBrowser();
  let endpoint = bound.get(b);
  if (!endpoint) {
    endpoint = b.bind("singularity-agent-browser").then((r) => r.endpoint);
    bound.set(b, endpoint);
  }
  try {
    return await endpoint;
  } catch (err) {
    bound.delete(b);
    throw err;
  }
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

function clearTimers(session: Session): void {
  if (session.idle) clearTimeout(session.idle);
  if (session.freeze) clearTimeout(session.freeze);
  if (session.scriptHold) clearTimeout(session.scriptHold);
}

function touch(session: Session): void {
  // A closed session's late page events must not re-arm its deadline.
  if (sessions.get(session.conversationId) !== session) return;
  if (session.idle) clearTimeout(session.idle);
  session.idleDeadline = new Date(Date.now() + SESSION_IDLE_MS);
  session.idle = setTimeout(() => {
    background("close-idle-session", () =>
      closeSession(session.conversationId),
    );
  }, SESSION_IDLE_MS);
}

/**
 * A request to a deploy behind the gateway (`http://<namespace>.localhost:9000`)
 * — this checkout's build, main, any other worktree. Those, and only those,
 * read the agent-origin headers and keep a write ledger to revert; anything
 * else (a CDN, a public website) never sees the headers.
 */
function isDeployOrigin(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.port === String(GATEWAY_PORT) &&
    namespaceFromHost(url.host) !== null
  );
}

/** The conversation's session, opened (and the browser launched) on first use. */
export async function getSession(
  conversationId: string,
  target: HostTarget,
): Promise<Session> {
  const existing = sessions.get(conversationId);
  if (existing) {
    existing.target = target;
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
  // The headers belong to the deploys only; strip them from every other origin.
  await context.route(
    (url) => !isDeployOrigin(url),
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
    raced.target = target;
    touch(raced);
    return raced;
  }
  const now = new Date();
  const session: Session = {
    conversationId,
    target,
    origins: new Set(),
    context,
    writes: trackWrites(context, isDeployOrigin),
    tabs: new Map(),
    current: null,
    nextTab: 1,
    openedAt: now,
    idleDeadline: now,
    idle: null,
    freeze: null,
    scriptHold: null,
  };
  sessions.set(conversationId, session);
  // Every page of the context is a tab — the ones a script attached through
  // `bindEndpoint` opens (and popups) too, not only `openTab`'s.
  context.on("page", (page) => adoptPage(session, page));
  context.on("request", (req) => {
    const url = new URL(req.url());
    if (!isDeployOrigin(url) || session.origins.has(url.origin)) return;
    session.origins.add(url.origin);
    onChange();
  });
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
  return adoptPage(session, await session.context.newPage());
}

/**
 * Make a page of the session's context one of its tabs (once), recording its
 * console and network from then on. Its traffic keeps the session alive only
 * under a script hold ({@link SCRIPT_HOLD_MS}): a script driving a tab makes no
 * MCP call, and must not be idle-closed mid-run.
 */
function adoptPage(session: Session, page: Page): Tab {
  const known = tabOfPage.get(page);
  if (known) return known;
  const tab: Tab = {
    id: `t${session.nextTab++}`,
    page,
    title: "",
    console: [],
    network: [],
    frozen: false,
    cdp: null,
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
  page.on("request", () => {
    if (session.scriptHold) touch(session);
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
  tabOfPage.set(page, tab);
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
 * Close a conversation's session: stop it sending anything new, wait for the
 * writes it already sent to land, drop its context, then revert the durable
 * writes IT made on every deploy it reached — its own request-origin source only, so
 * another conversation's session or an e2e run on the same deploy keeps
 * theirs. Returns false when there was none.
 */
export async function closeSession(conversationId: string): Promise<boolean> {
  const session = sessions.get(conversationId);
  if (!session) return false;
  sessions.delete(conversationId);
  clearTimers(session);
  try {
    const drained = await session.writes.drain(DRAIN_MS);
    if (drained.kind === "timeout") {
      recordHostError(
        `drain-writes ${conversationId}`,
        new Error(
          `${drained.pending.length} write(s) still unanswered after ${DRAIN_MS}ms, reverting anyway — if one lands later it is not reverted: ${drained.pending.join(", ")}`,
        ),
      );
    }
    await closeBounded(session.context.close(), "context");
    await revertSessionWritesOn([...session.origins], conversationId);
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

// ── Calls, freezing, script holds ─────────────────────────────────────────

/**
 * Run one tool call of a conversation: its session's tabs are thawed before
 * the call and frozen {@link FREEZE_AFTER_MS} after the last running call ends
 * (unless a script hold says a script may be driving them).
 */
export async function inCall<T>(
  conversationId: string,
  work: () => Promise<T>,
): Promise<T> {
  callsInFlight.set(
    conversationId,
    (callsInFlight.get(conversationId) ?? 0) + 1,
  );
  try {
    const session = sessions.get(conversationId);
    if (session) {
      if (session.freeze) clearTimeout(session.freeze);
      session.freeze = null;
      await thaw(session);
    }
    return await work();
  } finally {
    const left = (callsInFlight.get(conversationId) ?? 1) - 1;
    if (left === 0) callsInFlight.delete(conversationId);
    else callsInFlight.set(conversationId, left);
    const session = sessions.get(conversationId);
    if (session && left === 0) armFreeze(session);
  }
}

/**
 * A script is about to drive one of this session's tabs (`browser_attach`):
 * keep every tab rendering, and count the pages' traffic as use, for
 * {@link SCRIPT_HOLD_MS} from now.
 */
export function holdForScript(session: Session): void {
  if (session.scriptHold) clearTimeout(session.scriptHold);
  session.scriptHold = setTimeout(() => {
    session.scriptHold = null;
    if (sessions.get(session.conversationId) === session) armFreeze(session);
  }, SCRIPT_HOLD_MS);
}

function armFreeze(session: Session): void {
  if (session.freeze) clearTimeout(session.freeze);
  session.freeze = setTimeout(() => {
    session.freeze = null;
    if (sessions.get(session.conversationId) !== session) return;
    if (session.scriptHold || callsInFlight.has(session.conversationId)) return;
    background("freeze-tabs", () => setFrozen(session, true));
  }, FREEZE_AFTER_MS);
}

function thaw(session: Session): Promise<void> {
  return setFrozen(session, false);
}

function setFrozen(session: Session, frozen: boolean): Promise<void> {
  return lifecycle.run(session.conversationId, () =>
    applyFrozen(session, frozen),
  );
}

async function applyFrozen(session: Session, frozen: boolean): Promise<void> {
  // Re-checked under the lock: a call may have begun since the timer fired.
  if (
    frozen &&
    (session.scriptHold !== null ||
      callsInFlight.has(session.conversationId) ||
      sessions.get(session.conversationId) !== session)
  ) {
    return;
  }
  let changed = false;
  for (const tab of session.tabs.values()) {
    if (tab.frozen === frozen || tab.page.isClosed()) continue;
    tab.cdp ??= session.context.newCDPSession(tab.page);
    const cdp = await tab.cdp;
    if (frozen) {
      await cdp.send("Debugger.enable");
      await cdp.send("Debugger.pause");
    } else {
      await cdp.send("Debugger.disable");
    }
    tab.frozen = frozen;
    changed = true;
  }
  if (changed) onChange();
}
