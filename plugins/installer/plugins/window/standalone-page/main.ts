import { installIssueUrl, type FixTarget } from "@plugins/installer/core";
import {
  applyLine,
  captionParts,
  currentStep,
  emptyView,
  progress,
  statusText,
  type InstallView,
  type Notice,
  type Pause,
} from "./model";

/**
 * The installer window's page: draws the install's event stream. The native
 * window (../rust) owns the stream; it calls `window.installer.push(lines)`
 * with every protocol line in order (the whole backlog after `ready`),
 * `window.installer.confirmStop()` when the window is closed mid-install, and
 * `window.installer.askPassword(prompt)` when sudo asks for one (Linux). The
 * page answers through `window.ipc.postMessage` with one command of a closed
 * set, which the window checks again.
 *
 * The paused, fixing and done states are the approved mockup's
 * (proto-1794832268-wlybzk, its window view), pixel for pixel.
 */

/** A command with no argument. */
type Plain =
  | "ready"
  | "retry"
  | "quit"
  | "skip"
  | "stop"
  | "open-equin"
  | "close"
  | "drag"
  | "fix-app"
  | "fix-cli"
  | "show-claude"
  | "add-services"
  | "password-cancel";
type Command =
  | { cmd: Plain }
  | { cmd: "open-url"; url: string }
  | { cmd: "password"; value: string };

/** What the native window adds to the page's `window`. */
type InstallerWindow = Window & {
  ipc?: { postMessage(message: string): void };
  installer?: {
    push(lines: string[]): void;
    confirmStop(): void;
    askPassword(prompt: string): void;
  };
};
const host = window as InstallerWindow;

function send(command: Command): void {
  const ipc = host.ipc;
  if (ipc === undefined)
    throw new Error("the installer page runs outside its window (no ipc)");
  ipc.postMessage(JSON.stringify(command));
}

function post(cmd: Plain): void {
  send({ cmd });
}

/** The most log lines kept on screen; the full log stays in the stream. */
const LOG_ROWS = 2000;

/** Privacy & Security → App Management, the one settings link the window opens. */
const APP_MANAGEMENT_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles";

const view: InstallView = emptyView();
let renderedLog = 0;
let showLog = true;
/** The root's state class last drawn: the log is shown again when it changes, as in the mockup. */
let drawnState = "";
let decisionSent = false;
let confirming = false;
let fixMenu = false;
/** The notice's banner was skipped (Skip): the install goes on, the done screen keeps it. */
let noticeSkipped = false;

// ── Where Fix with Claude opens (remembered) ─────────────────────────────────

const CLAUDE_TARGETS: Record<FixTarget, { label: string; where: string }> = {
  app: { label: "Claude app", where: "the Claude app" },
  cli: { label: "Claude Code in Terminal", where: "Claude Code in Terminal" },
};
/**
 * The choice made in the menu, else where the last Fix with Claude went (the
 * stream remembers it across a reload), else the Claude app. Kept in the page:
 * it is one install's choice, and the page stores nothing.
 */
let pickedTarget: FixTarget | null = null;
let lastFixTarget: FixTarget | null = null;

function claudeTarget(): FixTarget {
  return pickedTarget ?? lastFixTarget ?? "app";
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

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

function button(
  label: string | Node[],
  cls: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el("button", cls);
  if (typeof label === "string") b.textContent = label;
  else b.append(...label);
  b.addEventListener("click", onClick);
  return b;
}

function withChildren(parent: HTMLElement, children: Node[]): HTMLElement {
  parent.append(...children);
  return parent;
}

const SVG = "http://www.w3.org/2000/svg";

/** An inline icon from its path(s) — the mockup's own glyphs. */
function svg(
  size: number,
  viewBox: string,
  paths: Array<Record<string, string>>,
  fill = "none",
): SVGSVGElement {
  const node = document.createElementNS(SVG, "svg");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("viewBox", viewBox);
  node.setAttribute("fill", fill);
  node.setAttribute("aria-hidden", "true");
  for (const attrs of paths) {
    const path = document.createElementNS(
      SVG,
      attrs.circle ? "circle" : "path",
    );
    for (const [k, v] of Object.entries(attrs))
      if (k !== "circle") path.setAttribute(k, v);
    node.append(path);
  }
  return node;
}

const stroke = (d: string, width = "1.8"): Record<string, string> => ({
  d,
  stroke: "currentColor",
  "stroke-width": width,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
});

const arrow = (): SVGSVGElement =>
  svg(15, "0 0 16 16", [stroke("M3 8h9.5M9 4.5L12.5 8 9 11.5")]);
const chevron = (): SVGSVGElement =>
  svg(12, "0 0 16 16", [stroke("M4 6l4 4 4-4")]);
const crossIcon = (): SVGSVGElement =>
  svg(11, "0 0 16 16", [
    {
      d: "M4 4l8 8M12 4l-8 8",
      stroke: "currentColor",
      "stroke-width": "2.4",
      "stroke-linecap": "round",
    },
  ]);
const clockIcon = (): SVGSVGElement =>
  svg(14, "0 0 16 16", [
    {
      circle: "1",
      cx: "8",
      cy: "8",
      r: "5.5",
      stroke: "currentColor",
      "stroke-width": "2",
    },
    {
      d: "M8 5v3.2l2 1.3",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
    },
  ]);
const checkIcon = (): SVGSVGElement =>
  svg(12, "0 0 16 16", [stroke("M3.5 8.5l3 3 6-7", "2.2")]);
const sparkle = (size = 14, color = "currentColor"): SVGSVGElement =>
  svg(
    size,
    "0 0 24 24",
    [
      { d: "M11 2.5l1.9 5.6 5.6 1.9-5.6 1.9L11 17.5l-1.9-5.6L3.5 10l5.6-1.9z" },
      { d: "M18.5 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" },
    ],
    color,
  );
const githubMark = (): SVGSVGElement =>
  svg(
    15,
    "0 0 24 24",
    [
      {
        d: "M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z",
      },
    ],
    "currentColor",
  );

// ── The bar and its caption ──────────────────────────────────────────────────

/** The bar and its caption: which step (of the plan's groups), and the time left. */
function progressBlock(paused: boolean): HTMLElement {
  const block = el("div", "iw-progress");
  const bar = el("div", paused ? "iw-bar paused" : "iw-bar");
  bar.append(el("i"));
  block.append(bar, el("div", "iw-eta"));
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
  eta.replaceChildren();
  captionParts(view, now).forEach((part, i) => {
    if (i > 0) eta.append(el("span", "sep", "·"));
    eta.append(part);
  });
}

// ── Actions on a pause ───────────────────────────────────────────────────────

/**
 * The mockup's WinActions: an optional primary action, Fix with Claude (a
 * split button remembering where Claude opens), Skip when the step may be
 * left out, and Report issue (an icon when Skip is there).
 */
function actions(opts: {
  primary: HTMLElement | null;
  report: string;
  skip: { tip: string; onSkip: () => void } | null;
  fix: boolean;
}): HTMLElement {
  const row = el("div", "iw-actions");
  if (opts.primary !== null) row.append(opts.primary);
  if (opts.fix) {
    const tone = opts.primary !== null ? "ghost" : "white";
    const target = claudeTarget();
    const split = el("div", `split ${tone}`);
    const fix = button(
      [sparkle(), document.createTextNode("Fix with Claude")],
      `pill ${tone} seg-l tip`,
      () => post(claudeTarget() === "cli" ? "fix-cli" : "fix-app"),
    );
    fix.dataset.tip = `Opens ${CLAUDE_TARGETS[target].where} with what went wrong and the install log already in the prompt. Claude asks before changing anything, and the install carries on here once it's fixed.`;
    const more = button([chevron()], `pill ${tone} seg-r`, () => {
      fixMenu = !fixMenu;
      renderBody();
    });
    more.setAttribute("aria-label", "Choose where Claude opens");
    split.append(fix, more);
    if (fixMenu) {
      const menu = el("div", "iw-menu");
      menu.addEventListener("mouseleave", () => {
        fixMenu = false;
        renderBody();
      });
      for (const key of ["app", "cli"] as const) {
        const ck = el("span", "ck");
        if (target === key) ck.append(checkIcon());
        menu.append(
          button(
            [ck, document.createTextNode(CLAUDE_TARGETS[key].label)],
            "",
            () => {
              pickedTarget = key;
              fixMenu = false;
              renderBody();
            },
          ),
        );
      }
      split.append(menu);
    }
    row.append(split);
  }
  if (opts.skip !== null) {
    const skip = button("Skip", "pill ghost tip", opts.skip.onSkip);
    skip.dataset.tip = opts.skip.tip;
    row.append(skip);
  }
  const report = button(
    opts.skip !== null
      ? [githubMark()]
      : [githubMark(), document.createTextNode("Report issue")],
    `pill ghost tip${opts.skip !== null ? " icon" : ""}`,
    () => send({ cmd: "open-url", url: opts.report }),
  );
  report.setAttribute("aria-label", "Report issue");
  report.dataset.tip =
    "Opens a new issue on GitHub, labelled install, with what happened and the log filled in. Nothing is sent until you submit it there.";
  row.append(report);
  return row;
}

/** The mockup's ErrorBox: what broke, why, and the lines that show it. */
function errorBox(
  title: string,
  text: string,
  evidence: readonly string[],
  amber: boolean,
): HTMLElement {
  const box = el("div", `iw-err fadein${amber ? " amber" : ""}`);
  const head = el("div", "h");
  head.append(amber ? clockIcon() : crossIcon(), el("b", undefined, title));
  box.append(head, el("p", undefined, text));
  if (evidence.length > 0) box.append(el("div", "ev", evidence.join("\n")));
  return box;
}

function reportUrl(
  title: string,
  text: string,
  evidence: readonly string[],
): string {
  return installIssueUrl({
    title,
    text,
    evidence,
    release: view.release,
    platform: view.platform,
  });
}

/** The bar block, centred under the actions (the mockup's wrapper). */
function barBelow(paused: boolean): HTMLElement {
  const wrap = el("div", "iw-barwrap");
  wrap.append(progressBlock(paused));
  return wrap;
}

function renderPaused(body: HTMLElement, pause: Pause): void {
  const stall = !pause.blocking;
  const decide = (d: "retry" | "skip"): void => {
    if (decisionSent) return;
    decisionSent = true;
    post(d);
    renderBody();
  };
  body.append(
    el(
      "h2",
      `iw-title${view.fixing === null ? " fadein" : ""}`,
      stall ? "Still waiting" : "Installation paused",
    ),
  );
  if (view.fixing !== null) {
    body.append(handoff(pause));
  } else {
    // Not one of the diagnosed kinds: nothing tells the person what to do
    // first, so trying again leads (the mockup's primary action slot).
    const primary =
      pause.kind === "unknown" && pause.blocking
        ? button("Try again", "pill white", () => decide("retry"))
        : null;
    if (primary !== null && decisionSent) primary.setAttribute("disabled", "");
    body.append(
      actions({
        primary,
        fix: true,
        report: reportUrl(pause.title, pause.text, pause.evidence),
        skip:
          pause.optional && pause.blocking
            ? {
                tip: "Go on without it: the install carries on with the next step.",
                onSkip: () => decide("skip"),
              }
            : null,
      }),
    );
  }
  // A stall's step still runs: its bar is not drawn paused.
  body.append(barBelow(!stall));
  if (!showLog)
    body.append(errorBox(pause.title, pause.text, pause.evidence, stall));
}

/** After Fix with Claude: Claude works in its own window; this one waits and picks the install up again. */
function handoff(pause: Pause): HTMLElement {
  const fixing = view.fixing;
  if (fixing === null)
    throw new Error("the handoff card is drawn while fixing only");
  const card = el("div", "iw-handoff fadein");
  const mark = el("span", "cl");
  mark.append(sparkle(13, "#fff"));
  const tx = el("div", "tx");
  const where =
    fixing.target === "cli"
      ? "In Terminal. The install carries on here once it's fixed."
      : fixing.clipboard
        ? "Paste it into the Claude app, from your clipboard."
        : "Paste what went wrong into Claude: it is saved beside the install log, as fix-prompt.md.";
  tx.append(
    el("b", undefined, "Claude is working on it"),
    el("span", undefined, where),
  );
  const row = el("div", "row");
  row.append(
    button("Show Claude", "pill ghost small", () => post("show-claude")),
  );
  // A stall's step is still running: there is nothing to try again.
  if (pause.blocking) {
    const again = button("Try again", "pill ghost small", () => {
      if (decisionSent) return;
      decisionSent = true;
      post("retry");
    });
    if (decisionSent) again.setAttribute("disabled", "");
    row.append(again);
  }
  card.append(mark, tx, row);
  return card;
}

/** A part the install is going on without (the banner while it runs). */
function noticeBanner(body: HTMLElement, notice: Notice): void {
  const open = button("Open App Management", "pill white", () =>
    send({ cmd: "open-url", url: APP_MANAGEMENT_URL }),
  );
  body.append(
    actions({
      primary: open,
      fix: false,
      report: reportUrl(notice.title, notice.text, []),
      skip: {
        tip: `Finish installing without ${notice.without}. equin works fully in your browser; you can add them once it's done.`,
        onSkip: () => {
          noticeSkipped = true;
          showLog = true;
          renderBody();
        },
      },
    }),
    errorBox(notice.title, notice.text, [], true),
  );
}

/** The done screen's line for a part left out: Add it now, then Add them. */
function laterLine(notice: Notice): HTMLElement | null {
  const line = el("div", "iw-later fadein");
  switch (notice.state) {
    case "skipped":
      line.append(`Installed without ${notice.without}. `);
      line.append(button("Add it now", "linkbtn", () => post("add-services")));
      return line;
    case "settings-opened":
      line.append(`${notice.text} `);
      line.append(button("Add them", "linkbtn", () => post("add-services")));
      return line;
    case "added":
      line.append(`Added ${notice.without}.`);
      return line;
  }
}

// ── The states ───────────────────────────────────────────────────────────────

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

/** The banner shows while a part left out has not been skipped or added. */
function bannerNotice(): Notice | null {
  const n = view.notice;
  return n !== null && n.state === "skipped" && !noticeSkipped ? n : null;
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

/** The root's state class: the mockup's `running | failed | fixing | done`. */
function stateClass(): string {
  if (view.phase === "done") return "done";
  if (view.phase === "paused")
    return view.fixing !== null ? "fixing" : "failed";
  if (view.phase === "failed") return "failed";
  return bannerNotice() !== null ? "failed" : "running";
}

function renderBody(): void {
  const body = byId("body");
  const state = stateClass();
  if (state !== drawnState) {
    // As in the mockup: the log shows while running, the diagnosis otherwise.
    showLog = state === "running";
    drawnState = state;
  }
  byId("root").className = `iw ${state}`;
  const notice = bannerNotice();
  if (view.phase === "running" && notice === null) {
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
    case "running":
      if (notice !== null) {
        const status = el("div", "iw-status", statusText(view, Date.now()));
        body.append(status, progressBlock(false));
        noticeBanner(body, notice);
      }
      break;
    case "paused":
      if (view.pause !== null) renderPaused(body, view.pause);
      break;
    case "failed": {
      // A failed step the script did not diagnose (an older script).
      body.append(
        el("h2", "iw-title fadein", "Installation paused"),
        el(
          "p",
          "iw-text fadein",
          `${cur?.step.label ?? "A step"} didn't finish. What it printed is in the log below. Trying again picks up where it stopped.`,
        ),
      );
      const again = button("Try again", "pill white", () =>
        decideOnce("retry"),
      );
      const quit = button("Quit", "pill ghost", () => decideOnce("quit"));
      if (decisionSent) {
        again.setAttribute("disabled", "");
        quit.setAttribute("disabled", "");
      }
      body.append(
        withChildren(el("div", "iw-actions"), [again, quit]),
        progressBlock(true),
      );
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
      const later = view.notice === null ? null : laterLine(view.notice);
      if (later !== null) body.append(later);
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

function decideOnce(decision: "retry" | "quit"): void {
  if (decisionSent) return;
  decisionSent = true;
  post(decision);
  renderBody();
}

/** The log's visibility, the pause's evidence at its end, and the foot's toggle. */
function renderChrome(): void {
  const log = byId("log");
  log.hidden = !(showLog && view.phase !== "done");
  // Paused, the log ends with the diagnosis's evidence (the mockup's LogPanel `extra`).
  const extra = byId("log-extra");
  const pause = view.pause;
  extra.replaceChildren(
    ...(pause === null
      ? []
      : pause.evidence.map((line) =>
          el("div", pause.blocking ? "err" : "hi", line),
        )),
  );
  log.classList.toggle(
    "has-extra",
    pause !== null && pause.evidence.length > 0,
  );
  byId("foot").hidden = view.phase === "done";
  byId("toggle-log").textContent = showLog ? "Hide log" : "Show log";
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

function render(): void {
  if (view.fixing !== null) lastFixTarget = view.fixing.target;
  // A decision is answered by what comes next: a new pause, or the step again.
  if (view.phase !== "failed" && view.phase !== "paused") decisionSent = false;
  renderBody();
  renderLog();
  syncClock();
}

function sheet(
  title: string,
  text: string,
  extra: HTMLElement[],
  buttons: HTMLElement[],
): { scrim: HTMLElement; close: () => void } {
  const scrim = el("div", "iw-scrim");
  const box = el("div", "iw-sheet");
  box.append(
    el("h3", undefined, title),
    el("p", undefined, text),
    ...extra,
    withChildren(el("div", "row"), buttons),
  );
  scrim.append(box);
  byId("root").append(scrim);
  return { scrim, close: () => scrim.remove() };
}

function confirmStop(): void {
  if (confirming) return;
  confirming = true;
  const done = (): void => {
    confirming = false;
    s.close();
  };
  const s = sheet(
    "Stop installing?",
    "Running the installer again picks up where it stopped.",
    [],
    [
      button("Keep installing", "pill ghost small", done),
      button("Stop", "pill white small", () => {
        done();
        post("stop");
      }),
    ],
  );
}

/** sudo's password (Linux): it goes to sudo only, never to a file or the log. */
function askPassword(prompt: string): void {
  document.querySelector(".iw-scrim.password")?.remove();
  const input = el("input", "iw-input");
  input.type = "password";
  input.autocomplete = "current-password";
  const answer = (): void => {
    s.close();
    send({ cmd: "password", value: input.value });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") answer();
  });
  const s = sheet(
    "equin needs your password",
    prompt,
    [input],
    [
      button("Cancel", "pill ghost small", () => {
        s.close();
        post("password-cancel");
      }),
      button("OK", "pill white small", answer),
    ],
  );
  s.scrim.classList.add("password");
  input.focus({ preventScroll: true });
}

host.installer = {
  push(lines) {
    for (const line of lines) applyLine(view, line);
    render();
  },
  confirmStop,
  askPassword,
};

// The title bar is transparent and the page fills it: its top strip moves
// the window.
byId("drag").addEventListener("mousedown", (e) => {
  if (e.button === 0) post("drag");
});
byId("toggle-log").addEventListener("click", () => {
  showLog = !showLog;
  renderBody();
});
render();
post("ready");
