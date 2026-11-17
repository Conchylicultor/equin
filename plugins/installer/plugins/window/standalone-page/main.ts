import {
  applyLine,
  captionParts,
  currentStep,
  emptyView,
  progress,
  statusText,
  type InstallView,
} from "./model";

/**
 * The installer window's page: draws the install's event stream. The native
 * window (../rust) owns the stream; it calls `window.installer.push(lines)`
 * with every protocol line in order (the whole backlog after `ready`), and
 * `window.installer.confirmStop()` when the window is closed mid-install.
 * The page answers through `window.ipc.postMessage` with one command of a
 * closed set (ready, retry, quit, stop, open-equin, close, drag).
 */

type Command =
  "ready" | "retry" | "quit" | "stop" | "open-equin" | "close" | "drag";

/** What the native window adds to the page's `window`. */
type InstallerWindow = Window & {
  ipc?: { postMessage(message: string): void };
  installer?: { push(lines: string[]): void; confirmStop(): void };
};
const host = window as InstallerWindow;

function post(cmd: Command): void {
  const ipc = host.ipc;
  if (ipc === undefined)
    throw new Error("the installer page runs outside its window (no ipc)");
  ipc.postMessage(JSON.stringify({ cmd }));
}

/** The most log lines kept on screen; the full log stays in the stream. */
const LOG_ROWS = 2000;

const view: InstallView = emptyView();
let renderedLog = 0;
let showLog = true;
let decisionSent = false;
let confirming = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no #${id}`);
  return node;
}

function button(label: string, cls: string, onClick: () => void): HTMLElement {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

function arrow(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 8h9.5M9 4.5L12.5 8 9 11.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** The bar and its caption: which step (of the plan's groups), and the time left. */
function progressBlock(paused: boolean): HTMLElement {
  const block = el("div", "iw-progress");
  const bar = el("div", paused ? "iw-bar paused" : "iw-bar");
  const fill = el("i");
  bar.append(fill);
  const eta = el("div", "iw-eta");
  block.append(bar, eta);
  updateProgress(block);
  return block;
}

/** Bring a progress block up to `now`, in place (the fill keeps its width transition). */
function updateProgress(block: HTMLElement): void {
  const now = Date.now();
  const fill = block.querySelector<HTMLElement>(".iw-bar > i");
  const eta = block.querySelector<HTMLElement>(".iw-eta");
  if (fill === null || eta === null)
    throw new Error("a progress block lost its bar");
  fill.style.width = `${(progress(view, now) * 100).toFixed(2)}%`;
  const parts = captionParts(view, now);
  eta.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) eta.append(el("span", "sep", "·"));
    eta.append(part);
  });
}

/**
 * The running state's nodes, built once and updated in place on every event
 * and clock tick — so the bar's width transitions instead of jumping.
 */
let running: { status: HTMLElement; block: HTMLElement } | null = null;

function renderRunning(body: HTMLElement): void {
  if (running === null || running.status.parentElement !== body) {
    running = { status: el("div", "iw-status"), block: progressBlock(false) };
    body.replaceChildren(running.status, running.block);
  }
  running.status.textContent = statusText(view, Date.now());
  updateProgress(running.block);
}

/**
 * A display clock, not polling: the data only changes when the window
 * pushes an event, but the time left and the bar are functions of now
 * (elapsed time against the estimates), so while the install runs the view
 * is redrawn once a second. A CSS transition cannot stand in for it: the
 * caption's minutes and a wait's "started N min ago" are text.
 */
let clock: ReturnType<typeof setInterval> | null = null;
function syncClock(): void {
  const want = view.phase === "running";
  if (want && clock === null)
    clock = setInterval(() => {
      if (view.phase === "running" && running !== null)
        renderRunning(byId("body"));
    }, 1000);
  else if (!want && clock !== null) {
    clearInterval(clock);
    clock = null;
  }
}

function renderBody(): void {
  const body = byId("body");
  const root = byId("root");
  root.className = `iw ${view.phase === "failed" ? "failed" : view.phase === "done" ? "done" : "running"}`;
  if (view.phase === "running") {
    renderRunning(body);
    renderChrome();
    return;
  }
  running = null;
  body.replaceChildren();
  const cur = currentStep(view);
  switch (view.phase) {
    case "waiting":
      body.append(el("div", "iw-status", "Getting ready…"));
      break;
    case "failed": {
      body.append(
        el("h2", "iw-title fadein", "Installation paused"),
        el(
          "p",
          "iw-text fadein",
          `${cur?.step.label ?? "A step"} didn't finish. What it printed is in the log below. Trying again picks up where it stopped.`,
        ),
      );
      const actions = el("div", "iw-actions");
      const again = button("Try again", "pill white", () => decide("retry"));
      const quit = button("Quit", "pill ghost", () => decide("quit"));
      if (decisionSent) {
        again.setAttribute("disabled", "");
        quit.setAttribute("disabled", "");
      }
      actions.append(again, quit);
      body.append(actions, progressBlock(true));
      break;
    }
    case "stopped":
      body.append(
        el("h2", "iw-title fadein", "Installation stopped"),
        el(
          "p",
          "iw-text fadein",
          "equin isn't installed yet. What happened is in the log below. Running the installer again picks up where it stopped.",
        ),
      );
      body.append(
        withChildren(el("div", "iw-actions"), [
          button("Close", "pill ghost", () => post("close")),
        ]),
      );
      break;
    case "done": {
      body.append(
        el("h2", "iw-title fadein", "You're all set"),
        el("p", "iw-text fadein", "equin opens by itself whenever you log in."),
      );
      const open = button("Open equin", "pill white big", () =>
        post("open-equin"),
      );
      open.append(arrow());
      body.append(withChildren(el("div", "iw-actions"), [open]));
      break;
    }
    case "protocol-error":
      body.append(
        el("h2", "iw-title", "This window can't follow the install"),
        el(
          "p",
          "iw-text",
          "The installer sent something this window doesn't understand, so it can't show what is happening. The install itself may still be running: close this window to stop it, then run the installer again in Terminal.",
        ),
        el("pre", "iw-evidence", view.protocolError ?? ""),
      );
      break;
  }
  renderChrome();
}

/** The log's visibility and the foot's toggle. */
function renderChrome(): void {
  const log = byId("log");
  log.hidden = !(showLog && view.phase !== "done");
  const foot = byId("foot");
  foot.hidden = view.phase === "done";
  byId("toggle-log").textContent = showLog ? "Hide log" : "Show log";
}

function withChildren(
  parent: HTMLElement,
  children: HTMLElement[],
): HTMLElement {
  parent.append(...children);
  return parent;
}

/**
 * Append the log rows not drawn yet. The log follows its end by itself: its
 * scroller is `column-reverse`, which keeps the view at the end while it
 * grows and where the reader left it once scrolled up (the mockup's
 * LogPanel does it with a scroll write, which the page has no need for).
 */
function renderLog(): void {
  const lines = byId("log-lines");
  const rows = view.log.slice(renderedLog);
  renderedLog = view.log.length;
  for (const row of rows) {
    lines.append(
      el(
        "div",
        row.kind === "section" ? "sec" : row.kind === "err" ? "err" : "",
        row.kind === "section" ? `▸ ${row.text}` : row.text,
      ),
    );
  }
  while (lines.childElementCount > LOG_ROWS) lines.firstElementChild?.remove();
}

function decide(decision: "retry" | "quit"): void {
  if (decisionSent) return;
  decisionSent = true;
  post(decision);
  renderBody();
}

function render(): void {
  // A new step start after a failure means the decision was taken.
  if (view.phase !== "failed") decisionSent = false;
  renderBody();
  renderLog();
  syncClock();
}

function confirmStop(): void {
  if (confirming) return;
  confirming = true;
  const scrim = el("div", "iw-scrim");
  const sheet = el("div", "iw-sheet");
  sheet.append(
    el("h3", undefined, "Stop installing?"),
    el(
      "p",
      undefined,
      "Running the installer again picks up where it stopped.",
    ),
  );
  const close = (): void => {
    confirming = false;
    scrim.remove();
  };
  sheet.append(
    withChildren(el("div", "row"), [
      button("Keep installing", "pill ghost small", close),
      button("Stop", "pill white small", () => {
        close();
        post("stop");
      }),
    ]),
  );
  scrim.append(sheet);
  byId("root").append(scrim);
}

host.installer = {
  push(lines) {
    for (const line of lines) applyLine(view, line);
    render();
  },
  confirmStop,
};

// The title bar is transparent and the page fills it: its top strip moves
// the window.
byId("drag").addEventListener("mousedown", (e) => {
  if (e.button === 0) post("drag");
});
byId("toggle-log").addEventListener("click", () => {
  showLog = !showLog;
  renderChrome();
});
render();
post("ready");
