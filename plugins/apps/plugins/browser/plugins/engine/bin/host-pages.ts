/**
 * The pages the engine host holds — ONE persistent Chromium context, one
 * `Page` per remote tab key — and the socket attached to each.
 *
 * A socket attaches to one key (its first message, `attach`); while attached
 * the page is screencast to it and the socket's input is dispatched into the
 * page over CDP. Detached, the page lives on (a tab the app is not showing):
 * frozen after {@link FREEZE_AFTER_MS}, closed after {@link PAGE_ORPHAN_MS}.
 * Every lifetime here is a one-shot deadline reset on use — never a poll.
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Page,
} from "playwright";
import { readyNow } from "@plugins/infra/plugins/deps/deps";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { backgroundOnlyChromium } from "./background-app";
import { launchPersistentChromium } from "@plugins/infra/plugins/deps/plugins/playwright-browser/deps";
import { chromium } from "@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/deps";
import {
  ClientMessageSchema,
  type ClientMessage,
  type EngineViewport,
  type HostEvent,
  type PageState,
} from "../core";
import {
  applySelect,
  ENGINE_BINDING,
  pageScript,
  readSelection,
  type PageReport,
} from "./page-script";
import { removeUploads, Upload, uploadsDirFor } from "./host-uploads";

/** A page no socket shows is closed after this (the app tab is gone, or long hidden). */
export const PAGE_ORPHAN_MS = 30 * 60_000;
/** The host exits this long after its last page and socket went. */
export const HOST_IDLE_MS = 30 * 60_000;
/**
 * A page no socket shows stops running JavaScript after this (`Debugger.pause`,
 * thawed on attach). Headless Chromium rasterizes on the CPU and a headless
 * page is always "visible", so a hidden tab that animates would otherwise burn
 * a core with nobody looking (see infra/mcp/browser's freezing).
 */
export const FREEZE_AFTER_MS = 60_000;
/** Frames are rendered at most at this device pixel ratio. */
const MAX_DPR = 2;
/** JPEG quality of a screencast frame. */
const FRAME_QUALITY = 70;
/** Past this many bytes queued on a socket, a frame is dropped rather than queued. */
const MAX_BUFFERED = 512 * 1024;

export interface SocketData {
  /** The key this socket attached to; `null` before its `attach`. */
  key: string | null;
  /** Messages are handled one at a time, in arrival order. */
  queue: Promise<void>;
  /** The upload whose bytes this socket's binary messages carry, while one is open. */
  upload: Upload | null;
}
export type ClientSocket = ServerWebSocket<SocketData>;

interface RemotePage {
  key: string;
  page: Page;
  cdp: CDPSession;
  client: ClientSocket | null;
  viewport: EngineViewport | null;
  /**
   * The newest frame held back while the socket is backpressured, sent (and
   * acked) once it drains — latest wins, so a stale frame never queues and
   * the last change is never lost.
   */
  held: { data: string; sessionId: number } | null;
  /**
   * The URL a navigation this host started is loading, until the main frame
   * commits a document — reported as the page's URL meanwhile (as Chrome's
   * omnibox shows the typed URL), so a fresh page never reports its initial
   * `about:blank`, which the app reads as "back to the start page".
   */
  pending: string | null;
  loading: boolean;
  title: string;
  favicon: string | null;
  lastState: string;
  /** A dialog the page is blocked on, until the client answers. */
  dialog: Dialog | null;
  /** The file chooser the page opened, until the client answers with `files`. */
  chooser: { chooser: FileChooser; multiple: boolean; accept: string } | null;
  /** Where this page's uploaded files are kept; minted on its first upload. */
  uploadsDir: string | null;
  frozen: boolean;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  freezeTimer: ReturnType<typeof setTimeout> | null;
}

const pages = new Map<string, RemotePage>();
const byPage = new Map<Page, RemotePage>();
const sockets = new Set<ClientSocket>();
/** Pages this host is creating itself — `context.on("page")` must not adopt them as popups. */
const ownPages = new WeakSet<Page>();
const pendingOwn = new Set<Promise<Page>>();
/** The page the user last sent input to: the opener of a `noopener` popup. */
let lastInput: RemotePage | null = null;

let context: Promise<BrowserContext> | null = null;
let hooks: {
  onChange: () => void;
  onIdle: () => void;
  profileDir: string;
} | null = null;
let hostIdle: ReturnType<typeof setTimeout> | null = null;
let hostIdleAt: Date | null = null;

export function wirePages(h: NonNullable<typeof hooks>): void {
  hooks = h;
  armHostIdle();
}

export function pagesSnapshot(): {
  pages: number;
  sockets: number;
  idleExitAt: string | null;
} {
  return {
    pages: pages.size,
    sockets: sockets.size,
    idleExitAt: hostIdleAt?.toISOString() ?? null,
  };
}

function changed(): void {
  hooks?.onChange();
}

function armHostIdle(): void {
  if (hostIdle) clearTimeout(hostIdle);
  hostIdle = null;
  hostIdleAt = null;
  if (pages.size > 0 || sockets.size > 0) return;
  hostIdleAt = new Date(Date.now() + HOST_IDLE_MS);
  hostIdle = setTimeout(() => hooks?.onIdle(), HOST_IDLE_MS);
}

function send(ws: ClientSocket | null, event: HostEvent): void {
  if (!ws) return;
  ws.send(JSON.stringify(event));
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The browser ──────────────────────────────────────────────────────────

async function getContext(): Promise<BrowserContext> {
  context ??= launch();
  try {
    return await context;
  } catch (err) {
    context = null;
    throw err;
  }
}

const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-component-update",
  // Every page renders at the highest scale a client gets (a retina canvas):
  // a headless screencast captures what the compositor draws, so a CDP
  // deviceScaleFactor alone came out 1x (blurry), and the `viewport` override
  // that forced device pixels pinned the captured region to the document's
  // top — scrolled-to content was never drawn. A 1x client gets the same
  // frames scaled down by the screencast's maxWidth/maxHeight.
  `--force-device-scale-factor=${MAX_DPR}`,
  // A person browses here, not a script: no `navigator.webdriver` (Blink's
  // AutomationControlled feature), which reCAPTCHA scores as a bot — an
  // endless run of challenges however many are answered.
  "--disable-blink-features=AutomationControlled",
];

/**
 * macOS runs Chromium HEADED, as a background-only app (`background-app.ts`):
 * the GPU draws its pages and sites see the browser they expect, not the
 * headless shell bot checks flag. Its windows live off-screen — nobody looks
 * at them, the app's canvas shows their pages — and are never throttled or
 * occluded as the hidden windows they are. Elsewhere (Linux: no display)
 * Chromium stays the headless shell.
 */
const HEADED = process.platform === "darwin";
const OFFSCREEN = -20_000;
const WINDOW = { width: 2560, height: 1600 };
const HEADED_ARGS = [
  `--window-position=${OFFSCREEN},${OFFSCREEN}`,
  `--window-size=${WINDOW.width},${WINDOW.height}`,
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

async function launch(): Promise<BrowserContext> {
  if (!hooks) throw new Error("[browser-engine] wirePages() first");
  // The backend made sure of the install before launching this host; reaching
  // here without it is a dependency removed since — say so.
  const installed = await readyNow(chromium);
  if (installed.kind !== "ready") {
    throw new Error(
      `Chromium is not installed (${installed.kind}). Run \`./equin deps install chromium\`.`,
    );
  }
  const options = {
    // The client's canvas decides the viewport (`Emulation.setDeviceMetricsOverride`
    // per attach), so Playwright must not emulate one of its own.
    viewport: null,
    acceptDownloads: true,
    headless: !HEADED,
    args: HEADED ? [...LAUNCH_ARGS, ...HEADED_ARGS] : LAUNCH_ARGS,
    ...(HEADED ? { derive: backgroundOnlyChromium } : {}),
    // Playwright's default: the automation infobar and `navigator.webdriver`.
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let ctx = await launchPersistentChromium(
    installed.ready,
    hooks.profileDir,
    options,
  );
  // The headless shell announces itself as `HeadlessChrome`, which sites
  // refuse or degrade. Relaunch as the Chrome it is (same version).
  const probe = ctx.pages()[0] ?? (await ctx.newPage());
  const ua = await probe.evaluate(() => navigator.userAgent);
  if (ua.includes("HeadlessChrome")) {
    await ctx.close();
    ctx = await launchPersistentChromium(installed.ready, hooks.profileDir, {
      ...options,
      userAgent: ua.replace("HeadlessChrome", "Chrome"),
    });
  }
  // The blank page a persistent launch opens is nobody's tab.
  for (const p of ctx.pages()) await p.close();

  await ctx.exposeBinding(ENGINE_BINDING, ({ page }, report: PageReport) => {
    const rp = byPage.get(page);
    if (rp) onReport(rp, report);
  });
  await ctx.addInitScript(pageScript);
  ctx.on("page", (page) => {
    void adoptPopup(page).catch(ignoreGone(page));
  });
  ctx.on("close", () => {
    // Chromium crashed or was closed: every page went with it.
    context = null;
    for (const rp of [...pages.values()]) forget(rp, "the browser closed");
  });
  return ctx;
}

/** Close every page and the browser (persisting the profile). */
export async function closeAll(): Promise<void> {
  const ctx = context;
  context = null;
  for (const ws of sockets) ws.close(1001, "browser engine exiting");
  if (!ctx) return;
  await (await ctx).close();
}

// ── Pages ────────────────────────────────────────────────────────────────

async function newOwnPage(ctx: BrowserContext): Promise<Page> {
  const created = ctx.newPage().then((p) => {
    ownPages.add(p);
    return p;
  });
  pendingOwn.add(created);
  try {
    return await created;
  } finally {
    pendingOwn.delete(created);
  }
}

/**
 * Put the page's window off-screen. Chromium places a window it opens
 * (a new window, a `window.open` popup) on the screen; the launch flags only
 * position the first one.
 */
async function moveOffscreen(cdp: CDPSession): Promise<void> {
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "normal" },
  });
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: { left: OFFSCREEN, top: OFFSCREEN, ...WINDOW },
  });
}

async function register(key: string, page: Page): Promise<RemotePage> {
  const ctx = await getContext();
  const cdp = await ctx.newCDPSession(page);
  const rp: RemotePage = {
    key,
    page,
    cdp,
    client: null,
    viewport: null,
    held: null,
    pending: null,
    loading: false,
    title: "",
    favicon: null,
    lastState: "",
    dialog: null,
    chooser: null,
    uploadsDir: null,
    frozen: false,
    orphanTimer: null,
    freezeTimer: null,
  };
  pages.set(key, rp);
  byPage.set(page, rp);
  wirePage(rp);
  await cdp.send("Page.enable");
  if (HEADED) await moveOffscreen(cdp);
  // Every page believes it has focus (caret, :focus, focus events), whichever
  // the user looks at.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  armHostIdle();
  changed();
  return rp;
}

function wirePage(rp: RemotePage): void {
  const { page, cdp } = rp;
  cdp.on("Page.screencastFrame", (frame) => {
    onFrame(rp, frame.data, frame.sessionId);
  });
  cdp.on("Page.frameStartedLoading", ({ frameId }) => {
    if (frameId !== mainFrameId(rp)) return;
    rp.loading = true;
    refresh(rp);
  });
  cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
    if (frameId !== mainFrameId(rp)) return;
    rp.loading = false;
    refresh(rp);
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    if (frame.url() !== "about:blank") rp.pending = null;
    // A new document: its title and icon come with its own report.
    rp.title = "";
    rp.favicon = null;
    refresh(rp);
  });
  page.on("domcontentloaded", () => refresh(rp));
  page.on("load", () => refresh(rp));
  page.on("dialog", (dialog) => {
    rp.dialog = dialog;
    sendDialog(rp);
  });
  // Listening is what makes Playwright intercept the chooser: the native
  // dialog would open in the off-screen window, where nobody can answer it.
  page.on("filechooser", (chooser) => {
    void onFileChooser(rp, chooser).catch(ignoreGone(page));
  });
  page.on("download", (download) => {
    saveDownload(rp, download).catch((err: unknown) => {
      send(rp.client, {
        t: "error",
        message: `Download failed: ${errorOf(err)}`,
      });
    });
  });
  page.on("close", () => forget(rp, "the page closed"));
}

/** Playwright's main frame id, read from the CDP frame tree once known. */
const mainFrameIds = new WeakMap<RemotePage, string>();
function mainFrameId(rp: RemotePage): string | undefined {
  return mainFrameIds.get(rp);
}
async function loadMainFrameId(rp: RemotePage): Promise<void> {
  const { frameTree } = await rp.cdp.send("Page.getFrameTree");
  mainFrameIds.set(rp, frameTree.frame.id);
}

function forget(rp: RemotePage, why: string): void {
  if (pages.get(rp.key) !== rp) return;
  pages.delete(rp.key);
  byPage.delete(rp.page);
  if (rp.orphanTimer) clearTimeout(rp.orphanTimer);
  if (rp.freezeTimer) clearTimeout(rp.freezeTimer);
  if (lastInput === rp) lastInput = null;
  if (rp.uploadsDir !== null) void removeUploads(rp.uploadsDir);
  if (rp.client) {
    rp.client.close(1000, why);
    rp.client = null;
  }
  armHostIdle();
  changed();
}

async function adoptPopup(page: Page): Promise<void> {
  // A page this host is opening itself fires `page` too, before `newPage`
  // resolves: wait for those, then it is ours or a popup.
  await Promise.allSettled([...pendingOwn]);
  if (ownPages.has(page) || byPage.has(page)) return;
  const openerPage = await page.opener();
  // `target=_blank` is `noopener` by default: no opener to name, so the page
  // the user last clicked in is the one that opened it.
  const opener = (openerPage && byPage.get(openerPage)) ?? lastInput;
  const rp = await register(crypto.randomUUID(), page);
  await loadMainFrameId(rp);
  armOrphan(rp);
  send(opener?.client ?? null, { t: "popup", key: rp.key, url: page.url() });
}

// ── State ────────────────────────────────────────────────────────────────

function onReport(rp: RemotePage, report: PageReport): void {
  switch (report.kind) {
    case "cursor":
      send(rp.client, { t: "cursor", value: report.value });
      return;
    case "meta":
      rp.title = report.title;
      rp.favicon = report.favicon;
      refresh(rp);
      return;
    case "select":
      send(rp.client, {
        t: "select",
        options: report.options,
        rect: report.rect,
      });
      return;
  }
}

function defaultFavicon(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}/favicon.ico`;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

async function readState(rp: RemotePage): Promise<PageState> {
  const { currentIndex, entries } = await rp.cdp.send(
    "Page.getNavigationHistory",
  );
  const url = rp.pending ?? rp.page.url();
  return {
    url: url === "about:blank" ? "" : url,
    title: rp.title,
    faviconUrl: rp.favicon ?? defaultFavicon(url),
    loading: rp.loading,
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < entries.length - 1,
  };
}

/** CDP's answer on a session whose page is going away. */
function isDetached(err: unknown): boolean {
  return (
    err instanceof Error &&
    /Not attached to an active page|Target closed|Session closed/.test(
      err.message,
    )
  );
}

/**
 * The rejection handler for page work started from an event: a page that
 * closed (or a CDP session detached) mid-way is the expected race and ends
 * quietly; anything else is rethrown — an unhandled rejection that takes the
 * host down loudly (the backend sees it `died` and relaunches it).
 */
function ignoreGone(page: Page): (err: unknown) => void {
  return (err) => {
    if (page.isClosed() || isDetached(err)) return;
    throw err;
  };
}

/** {@link pushState} from an event handler: a failure is logged, never unhandled. */
function refresh(rp: RemotePage): void {
  void pushState(rp).catch(ignoreGone(rp.page));
}

/** Send the page's state to its socket when it changed (or always, `force`). */
async function pushState(rp: RemotePage, force = false): Promise<void> {
  if (!rp.client || rp.page.isClosed()) return;
  let state: PageState;
  try {
    state = await readState(rp);
  } catch (err) {
    // The page closed mid-read (its `close` event may not have fired yet):
    // its close handler says so to the client.
    if (rp.page.isClosed() || isDetached(err)) return;
    throw err;
  }
  const key = JSON.stringify(state);
  if (!force && key === rp.lastState) return;
  rp.lastState = key;
  send(rp.client, { t: "state", state });
}

function sendDialog(rp: RemotePage): void {
  const d = rp.dialog;
  if (!d) return;
  send(rp.client, {
    t: "dialog",
    type: d.type() as "alert" | "confirm" | "prompt" | "beforeunload",
    message: d.message(),
    defaultValue: d.defaultValue(),
  });
}

async function onFileChooser(
  rp: RemotePage,
  chooser: FileChooser,
): Promise<void> {
  const accept = (await chooser.element().getAttribute("accept")) ?? "";
  // The newest wins: the page asked again (a second click).
  rp.chooser = { chooser, multiple: chooser.isMultiple(), accept };
  sendChooser(rp);
}

function sendChooser(rp: RemotePage): void {
  const c = rp.chooser;
  if (!c) return;
  send(rp.client, { t: "fileChooser", multiple: c.multiple, accept: c.accept });
}

/** Answer the pending chooser with the files the client is about to stream. */
async function startUpload(
  ws: ClientSocket,
  rp: RemotePage,
  files: Extract<ClientMessage, { t: "files" }>["files"],
): Promise<void> {
  const pending = rp.chooser;
  if (!pending) throw new Error("the page has no file chooser open");
  if (ws.data.upload) throw new Error("an upload is already in progress");
  rp.chooser = null;
  if (files.length === 0) return;
  if (!pending.multiple && files.length > 1) {
    throw new Error("the page takes one file");
  }
  rp.uploadsDir ??= uploadsDirFor();
  const upload = await Upload.start(pending.chooser, files, rp.uploadsDir);
  send(ws, { t: "upload", ...upload.progress });
  if (!upload.done) ws.data.upload = upload;
}

/** One chunk of the open upload; acked with its progress (the client's flow control). */
async function onUploadChunk(
  ws: ClientSocket,
  chunk: Uint8Array,
): Promise<void> {
  const upload = ws.data.upload;
  if (!upload) throw new Error("binary client message with no upload open");
  try {
    await upload.write(chunk);
  } catch (err) {
    ws.data.upload = null;
    await upload.abort();
    throw err;
  }
  if (upload.done) ws.data.upload = null;
  send(ws, { t: "upload", ...upload.progress });
}

/** A free `~/Downloads/<name>` — `name (1).ext`, `name (2).ext`, … when taken. */
function downloadPath(name: string): string {
  const dir = join(HOME_DIR, "Downloads");
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "download";
  let path = join(dir, name || "download");
  for (let i = 1; existsSync(path); i++)
    path = join(dir, `${stem} (${i})${ext}`);
  return path;
}

async function saveDownload(rp: RemotePage, download: Download): Promise<void> {
  const path = downloadPath(download.suggestedFilename());
  await download.saveAs(path);
  send(rp.client, {
    t: "download",
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
  });
}

// ── Screencast ───────────────────────────────────────────────────────────

function ack(rp: RemotePage, sessionId: number): void {
  // A page closing mid-frame has nobody to ack to.
  void rp.cdp
    .send("Page.screencastFrameAck", { sessionId })
    .catch(ignoreGone(rp.page));
}

function onFrame(rp: RemotePage, data: string, sessionId: number): void {
  const ws = rp.client;
  if (!ws) {
    ack(rp, sessionId);
    return;
  }
  // A frame that would queue behind others is stale by the time it lands:
  // hold it unacked (Chromium sends no other until the ack), and send it once
  // the socket drained (the `drain` handler).
  if (ws.getBufferedAmount() > MAX_BUFFERED) {
    rp.held = { data, sessionId };
    return;
  }
  sendFrame(rp, ws, data, sessionId);
}

function sendFrame(
  rp: RemotePage,
  ws: ClientSocket,
  data: string,
  sessionId: number,
): void {
  const sent = ws.send(Buffer.from(data, "base64"));
  if (sent === 0) {
    // Dropped (the socket is closing): nothing more to send it.
    return;
  }
  // Sent, or queued under backpressure (-1): either way it is on its way;
  // the next frame is held by the check above until the queue drains.
  ack(rp, sessionId);
}

/** The socket drained: send the frame held back, which acks it. */
export function onDrain(ws: ClientSocket): void {
  const rp = ws.data.key ? pages.get(ws.data.key) : undefined;
  if (!rp || rp.client !== ws || rp.held === null) return;
  if (ws.getBufferedAmount() > MAX_BUFFERED) return;
  const { data, sessionId } = rp.held;
  rp.held = null;
  sendFrame(rp, ws, data, sessionId);
}

async function applyViewport(rp: RemotePage, v: EngineViewport): Promise<void> {
  const dpr = Math.min(v.dpr, MAX_DPR);
  rp.viewport = { ...v, dpr };
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: v.width,
    height: v.height,
    // 0 = the window's own scale: the launch's forced MAX_DPR (see LAUNCH_ARGS).
    deviceScaleFactor: 0,
    mobile: false,
  });
  if (!rp.client) return;
  // The frame size follows the viewport: restart at the new size.
  await rp.cdp.send("Page.stopScreencast");
  await rp.cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: FRAME_QUALITY,
    maxWidth: Math.round(v.width * dpr),
    maxHeight: Math.round(v.height * dpr),
    everyNthFrame: 1,
  });
}

// ── Freezing / orphan close ──────────────────────────────────────────────

function clearPageTimers(rp: RemotePage): void {
  if (rp.orphanTimer) clearTimeout(rp.orphanTimer);
  if (rp.freezeTimer) clearTimeout(rp.freezeTimer);
  rp.orphanTimer = null;
  rp.freezeTimer = null;
}

function armOrphan(rp: RemotePage): void {
  clearPageTimers(rp);
  rp.orphanTimer = setTimeout(() => {
    void rp.page.close({ runBeforeUnload: false }).catch(ignoreGone(rp.page));
  }, PAGE_ORPHAN_MS);
  rp.freezeTimer = setTimeout(() => {
    void setFrozen(rp, true).catch(ignoreGone(rp.page));
  }, FREEZE_AFTER_MS);
}

async function setFrozen(rp: RemotePage, frozen: boolean): Promise<void> {
  if (rp.frozen === frozen || rp.page.isClosed()) return;
  rp.frozen = frozen;
  if (frozen) {
    await rp.cdp.send("Debugger.enable");
    await rp.cdp.send("Debugger.pause");
  } else {
    await rp.cdp.send("Debugger.disable");
  }
}

// ── Sockets ──────────────────────────────────────────────────────────────

export function onOpen(ws: ClientSocket): void {
  sockets.add(ws);
  armHostIdle();
  changed();
}

export function onClose(ws: ClientSocket): void {
  sockets.delete(ws);
  const upload = ws.data.upload;
  ws.data.upload = null;
  if (upload) void upload.abort();
  const rp = ws.data.key ? pages.get(ws.data.key) : undefined;
  if (rp && rp.client === ws) {
    rp.client = null;
    rp.held = null;
    if (!rp.page.isClosed()) {
      void rp.cdp.send("Page.stopScreencast").catch(ignoreGone(rp.page));
      armOrphan(rp);
    }
  }
  armHostIdle();
  changed();
}

export function onMessage(ws: ClientSocket, raw: string | Buffer): void {
  ws.data.queue = ws.data.queue.then(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (typeof raw !== "string") {
      try {
        await onUploadChunk(ws, raw);
      } catch (err) {
        console.error("[browser-engine] upload failed:", err);
        send(ws, { t: "error", message: `Upload failed: ${errorOf(err)}` });
      }
      return;
    }
    let msg: ClientMessage;
    try {
      msg = ClientMessageSchema.parse(JSON.parse(raw));
    } catch (err) {
      send(ws, { t: "error", message: `Bad message: ${errorOf(err)}` });
      ws.close(1008, "bad message");
      return;
    }
    try {
      await handle(ws, msg);
    } catch (err) {
      console.error(`[browser-engine] ${msg.t} failed:`, err);
      send(ws, { t: "error", message: `${msg.t}: ${errorOf(err)}` });
    }
  });
}

async function attach(
  ws: ClientSocket,
  msg: Extract<ClientMessage, { t: "attach" }>,
): Promise<void> {
  if (ws.data.key !== null) throw new Error("already attached");
  ws.data.key = msg.key;
  let rp = pages.get(msg.key);
  let fresh = false;
  if (!rp) {
    const ctx = await getContext();
    rp = await register(msg.key, await newOwnPage(ctx));
    await loadMainFrameId(rp);
    fresh = true;
  }
  // One socket per page: a newer attach (a reload, another window) wins.
  if (rp.client && rp.client !== ws) {
    send(rp.client, { t: "displaced" });
    rp.client.close(4000, "attached elsewhere");
  }
  rp.client = ws;
  rp.held = null;
  clearPageTimers(rp);
  await setFrozen(rp, false);
  // Tabs of one window: only the front one renders, so the viewed page is it.
  if (HEADED) await rp.page.bringToFront();
  await applyViewport(rp, msg.viewport);
  // A fresh page is about to load `msg.url`: its first state already says so
  // (never the initial about:blank — "" means the start page to the app).
  if (fresh && msg.url !== "") rp.pending = msg.url;
  await pushState(rp, true);
  sendDialog(rp);
  sendChooser(rp);
  if (fresh && msg.url !== "") navigate(rp, msg.url);
  changed();
}

function attached(ws: ClientSocket): RemotePage {
  const rp = ws.data.key ? pages.get(ws.data.key) : undefined;
  if (!rp || rp.client !== ws) throw new Error("not attached");
  return rp;
}

/** Start a navigation; its failure arrives as an `error` event, not a wait. */
function navigate(rp: RemotePage, url: string): void {
  rp.pending = url;
  refresh(rp);
  // A navigation that ends without committing (failed, or a download) stops
  // standing in for the page's URL — unless a newer one already replaced it.
  const settle = () => {
    if (rp.pending !== url) return;
    rp.pending = null;
    refresh(rp);
  };
  rp.cdp
    .send("Page.navigate", { url })
    .then(({ errorText }) => {
      if (!errorText) return;
      settle();
      // ERR_ABORTED: superseded by another navigation, or a download.
      if (errorText !== "net::ERR_ABORTED") {
        send(rp.client, { t: "error", message: `${url}: ${errorText}` });
      }
    })
    .catch((err: unknown) => {
      settle();
      send(rp.client, { t: "error", message: `${url}: ${errorOf(err)}` });
    });
}

async function goHistory(rp: RemotePage, delta: -1 | 1): Promise<void> {
  const { currentIndex, entries } = await rp.cdp.send(
    "Page.getNavigationHistory",
  );
  const entry = entries[currentIndex + delta];
  if (!entry) return;
  await rp.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
}

async function handle(ws: ClientSocket, msg: ClientMessage): Promise<void> {
  if (msg.t === "attach") return attach(ws, msg);
  const rp = attached(ws);
  const { cdp } = rp;
  switch (msg.t) {
    case "navigate":
      navigate(rp, msg.url);
      return;
    case "back":
      return goHistory(rp, -1);
    case "forward":
      return goHistory(rp, 1);
    case "reload":
      await cdp.send("Page.reload", {});
      return;
    case "stop":
      await cdp.send("Page.stopLoading");
      return;
    case "resize":
      return applyViewport(rp, msg.viewport);
    case "mouse":
      lastInput = rp;
      await cdp.send("Input.dispatchMouseEvent", {
        type: msg.type,
        x: msg.x,
        y: msg.y,
        button: msg.button,
        buttons: msg.buttons,
        clickCount: msg.clickCount,
        modifiers: msg.modifiers,
      });
      return;
    case "wheel":
      lastInput = rp;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: msg.x,
        y: msg.y,
        deltaX: msg.deltaX,
        deltaY: msg.deltaY,
        modifiers: msg.modifiers,
      });
      return;
    case "key":
      lastInput = rp;
      await cdp.send("Input.dispatchKeyEvent", {
        type: msg.type,
        key: msg.key,
        code: msg.code,
        windowsVirtualKeyCode: msg.keyCode,
        nativeVirtualKeyCode: msg.keyCode,
        text: msg.text || undefined,
        unmodifiedText: msg.text || undefined,
        modifiers: msg.modifiers,
        commands: msg.commands,
      });
      return;
    case "insertText":
      lastInput = rp;
      await cdp.send("Input.insertText", { text: msg.text });
      return;
    case "ime":
      lastInput = rp;
      await cdp.send("Input.imeSetComposition", {
        text: msg.text,
        selectionStart: msg.selectionStart,
        selectionEnd: msg.selectionEnd,
      });
      return;
    case "copy":
      send(ws, { t: "copied", text: await rp.page.evaluate(readSelection) });
      return;
    case "dialog": {
      const dialog = rp.dialog;
      rp.dialog = null;
      if (!dialog) return;
      if (msg.accept) await dialog.accept(msg.promptText);
      else await dialog.dismiss();
      return;
    }
    case "select":
      await rp.page.evaluate(applySelect, msg.value);
      return;
    case "files":
      return startUpload(ws, rp, msg.files);
    case "close":
      await rp.page.close({ runBeforeUnload: false });
      return;
  }
}
