import type {
  ConversationRuntime,
  RuntimeInfo,
  RuntimeSignal,
  TerminalMenuChoice,
} from "@plugins/conversations/server";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import {
  sameTerminalMenu,
  TerminalMenuChangedError,
  type TerminalMenu,
} from "@plugins/conversations/plugins/terminal-menu/core";
import {
  cliFlagFor,
  type ConversationModel,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  resolveEffortFlag,
  resolveEffortSettings,
  type EffortLevel,
} from "@plugins/conversations/plugins/effort-provider/core";
import { TMUX } from "@plugins/infra/plugins/paths/server";
import { requireClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  ensureMainWorktreeRoot,
  isCanonicalWorktreePath,
  isWorktreeOpActive,
} from "@plugins/infra/plugins/worktree/server";
import { backgroundPrefix } from "@plugins/packages/plugins/spawn-priority/server";
import { recordReport } from "@plugins/reports/server";
import { basename } from "node:path";
import { relayHookEntry } from "@plugins/conversations/plugins/question-relay/server";
import { tmuxSignalsDir } from "../../data-dirs";
import { AGENT_SESSION_WRAPPER } from "./agent-session-env";
import { resolveSessionState, type SessionState } from "./claude-session";
import { parseInputDraft } from "./input-draft";
import { PANE_ROW_FORMAT, parsePaneRows, type TmuxPane } from "./pane-rows";
import { asLaunchMessage } from "./launch-message";
import {
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
  settingsFlag,
  launchHookSettings,
} from "./launch-settings";
import { classifyPaneText, type PaneMenu } from "./pane-menu";
import { resolvePaneStatus } from "./pane-status";
import { captureProcessTree } from "./process-tree";
import { subscribeTmuxSignals } from "./signals";
import { chainedTmuxHookArgs } from "./tmux-hooks";
import { typedChunks } from "./typed-keys";

// AskUserQuestion menus must be detected regardless of how the pane otherwise
// reads, because nothing outside the pane's own pixels says a question is up:
//   - Old CLI: the menu kept the spinner + session status:"busy", so the pane
//     looked `working` while actually waiting.
//   - CLI v2.1.159: the menu presents as an IDLE pane — `✳` ready title prefix,
//     session file status:"waiting" / waitingFor:"permission prompt".
//   - CLI v2.1.276: same idle presentation, waitingFor:"input needed".
// Those last two spellings are also what the CLI writes when it is merely
// sitting at the prompt with nothing on screen, so neither the title nor the
// session file can tell a blocked question from an ordinary wait. Only the
// menu's own footer can — pane-menu.ts owns that reading, including the rule
// that separates a live menu from one already answered.
//
// We therefore probe EVERY non-dead pane we describe (not just working ones)
// and, on a match, override the verdict to {working:false,
// waitingFor:"question"} — the signal the AskUserQuestion web form gates on.
// Each probe is a FRESH capture: describing a pane happens once per reconcile,
// i.e. per push signal (a sessions-file write, a Claude Code question hook, a
// tmux hook) or per sweep — never on a timer, so there is no rate to throttle.

// Single fresh capture-pane → which interactive menu (if any) is on screen.
// `-S -15` reaches a little into scrollback, which always covers the whole
// visible pane too, so the composer that pane-menu.ts looks for is in frame
// whenever the CLI is rendering it.
async function classifyPaneMenu(id: string): Promise<PaneMenu> {
  const proc = Bun.spawn([TMUX, "capture-pane", "-p", "-S", "-15", "-t", id], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return classifyPaneText(stdout);
}

// escapeUntilPromptCleared() form-dismissal poll. After an Escape the TUI takes
// ~210ms to re-render from the prompt menu back to the idle input; under heavy
// concurrent load capture-pane can lag further behind the real CLI state. We
// poll a FRESH capture each iteration until no menu remains.
//
// The cadence is the whole ballgame. A single Escape DOES reliably dismiss the
// AskUserQuestion menu (verified, CLI v2.1.161) — the danger is sending a SECOND
// one too soon. The prior implementation re-fired Escape every 500ms while the
// footer was still on screen, but capture-pane lags the real CLI: once Escape
// dismissed the menu, the CLI sat at idle while the capture still showed the
// stale footer, so the next cadence Escape (and the one after) landed at idle —
// an Esc-Esc that opens Claude's *rewind* menu. That is the crash this fixes.
//
// So we space Escapes by ESCAPE_MIN_GAP_MS — comfortably longer than the
// re-render lag — and re-check state before each one. In the common case the
// menu clears after the first Escape and we observe idle before the gap
// elapses, sending exactly one keystroke. A second Escape only fires if the
// menu is STILL present a full gap later (a genuinely dropped keystroke, not
// lag), where re-pressing is safe because the menu really is up. And because
// classifyPaneMenu() recognises the rewind menu as a menu (not idle), any
// rewind opened by a queued/overshot keystroke is just escaped away on a later
// tick instead of being mistaken for the cleared prompt — rewind is recoverable,
// never an absorbing trap.
const FORM_CLEAR_POLL_INTERVAL_MS = 100;
const ESCAPE_MIN_GAP_MS = 1_500;
const FORM_CLEAR_TIMEOUT_MS = 6_000;

// awaitPromptMenu() — the phase BEFORE the Escape loop. A question can now be
// known before it is drawn: the PreToolUse hook fires ahead of the menu's
// paint, so a dismissal started on that knowledge can find the pane still
// reading `idle`. Seen first, `idle` is render lag, not clearance — so wait (a
// fresh capture each 100 ms, at most MENU_APPEAR_TIMEOUT_MS) for a menu to
// appear before deciding there is nothing to dismiss.
const MENU_APPEAR_TIMEOUT_MS = 3_000;

// typeTurn() submit-verification poll. The CLI is an async (Ink/React) TUI:
// when tmux writes the turn's text and Enter into the PTY in one read chunk,
// the input handler schedules a React state update but the trailing Enter is
// processed in the SAME tick — before the text commits to state — so it fires
// against an empty draft and submits nothing (the user then has to press Enter
// manually). A fixed inter-key delay only papers over this: under concurrent
// load the render can lag past any constant.
//
// Instead we verify against the rendered input box, the same self-healing shape
// answerPrompt() uses for Escape. The Claude idle input is a `❯` prompt line
// bounded by full-width `─` rules; its draft content is everything between the
// prompt glyph and the next rule. We (1) poll until that draft is non-empty —
// proof the text committed — then (2) send Enter and poll until the draft
// clears again, RE-SENDING Enter on SUBMIT_ENTER_RETRY_MS if it lingers (a
// dropped/early keystroke). A second Enter on an already-empty box is a no-op,
// so retry is safe. Timeouts are generous because many concurrent agents slow
// tmux/Ink.
//
// Both timeouts are VERIFICATION outcomes, not delivery failures: they report
// and return, because by then the keystrokes are already in the pane and only
// the transcript can say whether the agent took them. typeTurn throws only
// when a tmux command itself fails — i.e. when the text provably never left us.
const SUBMIT_POLL_INTERVAL_MS = 75;
const SUBMIT_ENTER_RETRY_MS = 500;
const TEXT_COMMIT_TIMEOUT_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 5_000;
// Used only when the input box can't be parsed (unrecognized CLI render): the
// proven fixed delay between committed text and Enter, the pre-chaining
// mitigation. Strictly better than firing Enter in the same chunk as the text.
const FALLBACK_SUBMIT_DELAY_MS = 150;

/**
 * Read the pane's current input-box draft, or null when the box can't be located
 * (unrecognized render). Captured WITH escapes (`-e`) so parseInputDraft can drop
 * the dim autosuggestion ghost Claude Code pre-fills and the queued-message
 * placeholder — both rendered faint. A plain capture strips colour and every
 * ghost would read as a real draft (a false "there is a draft" → spurious C-c in
 * send()). All parsing is pure and unit-tested in input-draft.test.ts.
 */
async function captureInputDraft(
  conversationId: string,
): Promise<string | null> {
  const proc = Bun.spawn(
    [TMUX, "capture-pane", "-e", "-p", "-S", "-50", "-t", conversationId],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return parseInputDraft(stdout);
}

// waitForInputReady() — how long a freshly started agent may take to draw its
// input box before a held turn gives up on it (5–9 s is typical at the current
// host load; the bound is generous for a box under heavy concurrent load), and
// the cadence of the check, the same fresh capture typeTurn polls.
const INPUT_READY_TIMEOUT_MS = 60_000;
const INPUT_READY_POLL_INTERVAL_MS = 250;

/**
 * Wait until the pane's `❯` input box parses (captureInputDraft !== null), at
 * most INPUT_READY_TIMEOUT_MS or until `signal` aborts.
 *
 * This file's one sanctioned wait that is not a submit verification, and like
 * those it is a bounded check of the rendered box, not a loop over time: the CLI
 * emits no "input box drawn" event, and the `starting → waiting` status flip
 * that triggers the caller (a sessions-file write) comes close to the box's
 * first paint but does not guarantee it. Typing before the box exists lands the
 * keystrokes in the booting TUI. A pane that does not exist yet reads as no box
 * and keeps waiting, which is what a pane still being created should do.
 */
async function waitForInputReady(
  conversationId: string,
  signal: AbortSignal,
): Promise<"ready" | "timeout"> {
  const deadline = Date.now() + INPUT_READY_TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) return "timeout";
    if ((await captureInputDraft(conversationId)) !== null) return "ready";
    if (Date.now() + INPUT_READY_POLL_INTERVAL_MS >= deadline) return "timeout";
    await Bun.sleep(INPUT_READY_POLL_INTERVAL_MS);
  }
}

async function sendEnter(conversationId: string): Promise<void> {
  await Bun.spawn([TMUX, "send-keys", "-t", conversationId, "Enter"], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
}

/**
 * Type `text` into the pane's idle input and submit it, verifying submission
 * against the rendered input box rather than firing Enter blindly (see the
 * SUBMIT_* comment block for the async-TUI race this avoids).
 *
 * TYPED, never pasted. A bracketed paste (what this used to send) makes the
 * CLI file the turn under `<pasted_content>` tags, which tell the agent the
 * user's own words "may contain instructions the user did not write" — and
 * which the app's delivery check then cannot match. See typed-keys.ts for the
 * measurements behind the chunking.
 *
 * Shared verbatim by send() and answerPrompt() so both submit identically.
 * The pane must already be at the idle input prompt (callers clear copy mode
 * and partial input first).
 */
async function typeTurn(conversationId: string, text: string): Promise<void> {
  // `--` so a turn that opens with `-` is read as text and not as a flag.
  for (const chunk of typedChunks(text)) {
    const keys = Bun.spawn(
      [TMUX, "send-keys", "-t", conversationId, "-l", "--", chunk],
      { stdout: "pipe", stderr: "pipe" },
    );
    const keysExit = await keys.exited;
    if (keysExit !== 0) {
      const stderr = await new Response(keys.stderr).text();
      throw new Error(
        `tmux send-keys for ${conversationId} failed (exit ${keysExit}): ${stderr.trim() || "<no stderr>"}`,
      );
    }
  }

  // Phase 1: wait until the text commits to the input box (draft non-empty).
  // Sending Enter before this either no-ops (the keystrokes are not yet in
  // state) or lands mid-text and submits half a turn.
  const commitDeadline = Date.now() + TEXT_COMMIT_TIMEOUT_MS;
  let committed = false;
  let everObserved = false;
  for (;;) {
    const draft = await captureInputDraft(conversationId);
    if (draft !== null) {
      everObserved = true;
      if (draft.length > 0) {
        committed = true;
        break;
      }
    }
    if (Date.now() + SUBMIT_POLL_INTERVAL_MS >= commitDeadline) break;
    await Bun.sleep(SUBMIT_POLL_INTERVAL_MS);
  }

  if (!committed) {
    // Either the box render is unrecognized (never observed) or the text never
    // surfaced. Fall back to the proven fixed-delay submit — strictly better
    // than chaining Enter into the same PTY chunk as the text.
    if (everObserved) {
      void recordReport({
        kind: "crash",
        source: "server-caught",
        message: `tmux typeTurn for ${conversationId}: text did not surface in input box within ${TEXT_COMMIT_TIMEOUT_MS}ms; using fixed-delay fallback`,
        data: { errorType: "TmuxSubmitError", label: "tmux-runtime.typeTurn" },
      });
    }
    await Bun.sleep(FALLBACK_SUBMIT_DELAY_MS);
    await sendEnter(conversationId);
    return;
  }

  // Phase 2: submit and verify. Re-send Enter until the box clears (a cleared
  // box, after a confirmed non-empty draft, is a real submission).
  const submitDeadline = Date.now() + SUBMIT_TIMEOUT_MS;
  let nextEnterAt = 0;
  for (;;) {
    if (Date.now() >= nextEnterAt) {
      await sendEnter(conversationId);
      nextEnterAt = Date.now() + SUBMIT_ENTER_RETRY_MS;
    }
    const draft = await captureInputDraft(conversationId);
    if (draft === "") return; // box cleared → submitted
    if (Date.now() + SUBMIT_POLL_INTERVAL_MS >= submitDeadline) break;
    await Bun.sleep(SUBMIT_POLL_INTERVAL_MS);
  }

  // Unverified, NOT failed — and the difference is why this reports instead of
  // throwing. Everything with a side effect already happened: the text is in
  // the pane and Enter has been sent (repeatedly). What ran out of time is the
  // capture-pane READ that confirms the box cleared — and under host duress
  // (spawn-bound polls, a lagging Ink render) that read loses the race against
  // a submit that did land. Throwing here surfaced a delivered turn to the
  // client as `HTTP 500 — Failed to send`, next to the message itself. The
  // pending-turn client owns this exact verdict already: it holds the record in
  // `posted` and resolves it against the transcript, which is the only ground
  // truth for "did the agent get it" — routing to `unconfirmed` + its own
  // report if it never lands. So the honest outcome is a 200 plus this report.
  void recordReport({
    kind: "crash",
    source: "server-caught",
    message: `tmux typeTurn for ${conversationId}: draft did not clear within ${SUBMIT_TIMEOUT_MS}ms despite repeated Enter; submission unverified (transcript decides)`,
    data: { errorType: "TmuxSubmitError", label: "tmux-runtime.typeTurn" },
  });
}

/**
 * Wait until a prompt menu is on screen, at most MENU_APPEAR_TIMEOUT_MS (see the
 * constant). Returns whether one appeared; on `false` the menu was never drawn
 * or is already gone (answered in the terminal), and there is nothing to
 * dismiss.
 */
async function awaitPromptMenu(conversationId: string): Promise<boolean> {
  const deadline = Date.now() + MENU_APPEAR_TIMEOUT_MS;
  for (;;) {
    if ((await classifyPaneMenu(conversationId)).kind !== "idle") return true;
    if (Date.now() + FORM_CLEAR_POLL_INTERVAL_MS >= deadline) return false;
    await Bun.sleep(FORM_CLEAR_POLL_INTERVAL_MS);
  }
}

/**
 * Dismiss the active prompt menu (AskUserQuestion), pressing Escape until the
 * pane returns to the idle input — but spacing Escapes by ESCAPE_MIN_GAP_MS so
 * we never stack two into an Esc-Esc that opens Claude's rewind menu. Each
 * iteration re-classifies the pane from a FRESH capture:
 *   - idle     → cleared, return.
 *   - question → press Escape, but at most once per ESCAPE_MIN_GAP_MS. The
 *                common case clears on the first press and reaches idle before
 *                the gap elapses (one keystroke total); a second press only
 *                fires if the menu is genuinely still up a full gap later.
 *   - rewind   → an overshot/queued Escape already dismissed the question and
 *                opened rewind; it is just another menu, so the same gated
 *                Escape closes it back to idle. Recognising it (instead of
 *                reading it as idle) is what keeps it from being left stranded.
 *
 * Exit copy mode before each Escape so the key reaches Claude rather than
 * tmux's vi bindings (see send()). Throws if the pane never reaches idle within
 * FORM_CLEAR_TIMEOUT_MS rather than letting the caller send into a live menu
 * (which would auto-select a wrong option and fabricate an answer).
 *
 * Shared by answerPrompt() (which then pastes the answer) and
 * flushInteractivePrompt() (which stops here, sending no answer).
 */
async function escapeUntilPromptCleared(conversationId: string): Promise<void> {
  const deadline = Date.now() + FORM_CLEAR_TIMEOUT_MS;
  let lastEscapeAt = -Infinity;
  for (;;) {
    if ((await classifyPaneMenu(conversationId)).kind === "idle") return;
    // A menu (question or rewind) is up. Press Escape only if we haven't pressed
    // within the last gap — long enough for a prior Escape's re-render to land,
    // so we never Esc-Esc a pane that has already reached idle under render lag.
    if (Date.now() - lastEscapeAt >= ESCAPE_MIN_GAP_MS) {
      await Bun.spawn([TMUX, "copy-mode", "-q", "-t", conversationId], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn([TMUX, "send-keys", "-t", conversationId, "Escape"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      lastEscapeAt = Date.now();
    }
    if (Date.now() + FORM_CLEAR_POLL_INTERVAL_MS >= deadline) break;
    await Bun.sleep(FORM_CLEAR_POLL_INTERVAL_MS);
  }
  // Never send into a live menu — that fabricates a wrong answer.
  throw new Error(
    `tmux escapeUntilPromptCleared for ${conversationId}: prompt menu did not clear ` +
      `within ${FORM_CLEAR_TIMEOUT_MS}ms despite repeated Escape; refusing to send`,
  );
}

// answerMenu() — each keystroke is followed by a FRESH capture until the menu
// shows its effect, for the same async-TUI reason typeTurn() verifies its
// submit: keys written in one PTY chunk can outrun the render, so an Enter sent
// straight after the arrows could confirm the option the cursor was on before.
const MENU_STEP_TIMEOUT_MS = 3_000;

async function tmuxKeys(conversationId: string, keys: string[]): Promise<void> {
  // Named keys (Down, Enter, Escape), never `-l`: literal mode types the names.
  await Bun.spawn([TMUX, "send-keys", "-t", conversationId, ...keys], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
}

/** The numbered menu on screen, or null when the pane shows anything else. */
async function readOpenMenu(
  conversationId: string,
): Promise<TerminalMenu | null> {
  const read = await classifyPaneMenu(conversationId);
  return read.kind === "menu" ? read.menu : null;
}

/**
 * Poll fresh captures until `done` holds of the pane's menu (null = no
 * numbered menu on screen), at most MENU_STEP_TIMEOUT_MS. Throws on timeout —
 * the caller must not send its next key against a screen it has not seen.
 */
async function awaitMenu(
  conversationId: string,
  what: string,
  done: (menu: TerminalMenu | null) => boolean,
): Promise<void> {
  const deadline = Date.now() + MENU_STEP_TIMEOUT_MS;
  for (;;) {
    if (done(await readOpenMenu(conversationId))) return;
    if (Date.now() + FORM_CLEAR_POLL_INTERVAL_MS >= deadline) break;
    await Bun.sleep(FORM_CLEAR_POLL_INTERVAL_MS);
  }
  throw new Error(
    `tmux answerMenu for ${conversationId}: ${what} within ${MENU_STEP_TIMEOUT_MS}ms`,
  );
}

/**
 * Answer the numbered menu on screen: re-read it, refuse unless it still offers
 * the chosen label at the chosen number, move the cursor there (one arrow per
 * step, verified on screen), press Enter, and wait for the menu to go. Cancel is
 * one Escape, sent only while a menu is up — at an idle prompt a second Escape
 * opens the rewind menu.
 */
async function answerOpenMenu(
  conversationId: string,
  choice: TerminalMenuChoice,
): Promise<void> {
  await Bun.spawn([TMUX, "copy-mode", "-q", "-t", conversationId], {
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  const menu = await readOpenMenu(conversationId);
  if (!menu) {
    throw new TerminalMenuChangedError(
      "The menu is no longer open in the terminal.",
    );
  }
  // Answered: this menu is off the screen (another may have replaced it).
  const gone = (now: TerminalMenu | null) =>
    now === null || !sameOptions(now, menu);
  if (choice.kind === "cancel") {
    await tmuxKeys(conversationId, ["Escape"]);
    await awaitMenu(conversationId, "the menu did not close", gone);
    return;
  }
  const option = menu.options.find((o) => o.n === choice.n);
  if (option?.label !== choice.label) {
    throw new TerminalMenuChangedError(
      `The menu changed: option ${choice.n} is now ` +
        `${option ? `"${option.label}"` : "gone"}, not "${choice.label}". Nothing was sent.`,
    );
  }
  let at = menu.highlighted;
  while (at !== choice.n) {
    const step = at < choice.n ? 1 : -1;
    await tmuxKeys(conversationId, [step > 0 ? "Down" : "Up"]);
    const target = at + step;
    await awaitMenu(
      conversationId,
      `the cursor did not reach option ${target}`,
      (now) =>
        now !== null && sameOptions(now, menu) && now.highlighted === target,
    );
    at = target;
  }
  await tmuxKeys(conversationId, ["Enter"]);
  await awaitMenu(conversationId, "the menu did not close after Enter", gone);
}

/** The same menu, wherever its cursor is. */
function sameOptions(a: TerminalMenu, b: TerminalMenu): boolean {
  return sameTerminalMenu(a, { ...b, highlighted: a.highlighted });
}

/**
 * Live tmux panes we manage, keyed by conversation id (the tmux session name).
 *
 * Exported so out-of-plugin observers (the session-divergence monitor) can join
 * a conversation to its pane pid through this one implementation rather than
 * re-deriving `tmux list-panes` — including its "no server running" empty-state
 * nuance, which a second copy would inevitably get wrong.
 */
export async function listPanes(): Promise<Map<string, TmuxPane>> {
  const proc = Bun.spawn(
    // No tmux-side `-f` filter: which sessions are ours is decided once, in JS
    // (`parsePaneRows`, pane-rows.ts).
    [TMUX, "list-panes", "-a", "-F", PANE_ROW_FORMAT],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (exit !== 0) {
    // "no server running" is a legitimate empty state — tmux had no sessions
    // so it could not start a server to query. Any other non-zero exit
    // (FD exhaustion, hung server, killed mid-call) means we cannot trust
    // emptiness as truth; throw so the reconciler treats this runtime's state
    // as unknown rather than declaring every conversation gone.
    if (/no server running/i.test(stderr)) return new Map();
    throw new Error(
      `tmux list-panes failed (exit ${exit}): ${stderr.trim() || "<no stderr>"}`,
    );
  }
  const repoRoot = await ensureMainWorktreeRoot();
  return parsePaneRows(stdout, (path) =>
    isCanonicalWorktreePath(path, repoRoot),
  );
}

const NULL_SESSION: SessionState = {
  sessionId: null,
  status: null,
  waitingFor: null,
};

/**
 * The live state of each of `panes`: one process snapshot for all of them, each
 * pane's claimed session, its working/waiting verdict, and a fresh menu probe.
 * Shared by `list()` and `inspect()` so the two can never describe a pane
 * differently.
 */
async function describePanes(
  panes: Map<string, TmuxPane>,
): Promise<Map<string, RuntimeInfo>> {
  const out = new Map<string, RuntimeInfo>();
  if (panes.size === 0) return out;
  const ids = Array.from(panes.keys());
  // One process snapshot for every pane. A failure here throws, which the
  // reconciler reads as "runtime state unknown" — same contract as a failed
  // `tmux list-panes`, and far safer than resolving against an empty tree.
  const tree = await captureProcessTree();
  const states = await Promise.all(
    ids.map(async (id) => {
      try {
        return await resolveSessionState(panes.get(id)!, tree);
      } catch (err) {
        void recordReport({
          kind: "crash",
          source: "server-caught",
          message: `resolveSessionState failed for pane "${id}": ${err instanceof Error ? err.message : String(err)}`,
          data: {
            errorType: "SessionStateError",
            label: "tmux-runtime.resolveSessionState",
          },
        });
        return NULL_SESSION;
      }
    }),
  );
  // Only the ambiguous "shell" state needs the build/push-in-flight signal,
  // so we skip the filesystem scan for every other pane. isWorktreeOpActive is
  // async (off-event-loop), so resolve every pane's op state in parallel up
  // front, then consume it synchronously when assembling the map.
  const opActives = await Promise.all(
    ids.map((id, i) => {
      const { worktreePath } = panes.get(id)!;
      const state = states[i]!;
      return state.status === "shell" && worktreePath
        ? isWorktreeOpActive(basename(worktreePath))
        : Promise.resolve(false);
    }),
  );
  // Probe every non-dead pane for the AskUserQuestion menu's footer. The menu
  // can present as either working (old CLI spinner bug) or idle (CLI v2.1.159,
  // see the comment at classifyPaneMenu), so we cannot pre-filter on
  // `working`. A match overrides whatever the title / session file said
  // (including waitingFor:"permission prompt") to {working:false,
  // waitingFor:"question"}.
  const menus = await Promise.all(
    ids.map((id) =>
      panes.get(id)!.dead ? Promise.resolve(null) : classifyPaneMenu(id),
    ),
  );

  ids.forEach((id, i) => {
    const { rawTitle, dead, worktreePath } = panes.get(id)!;
    const state = states[i]!;
    const resolved = resolvePaneStatus(rawTitle, state, opActives[i]!);
    const menu = menus[i] ?? null;
    const question = menu?.kind === "question";
    // Any other numbered menu stops the turn the same way: the CLI sits on it
    // until someone answers, whatever its title or session file say.
    const numbered = menu?.kind === "menu" ? menu.menu : null;
    out.set(id, {
      title: resolved.title,
      working: resolved.working && !dead && !question && !numbered,
      dead,
      claudeSessionId: state.sessionId ?? null,
      worktreePath,
      waitingFor: dead ? null : question ? "question" : resolved.waitingFor,
      menu: dead ? null : numbered,
    });
  });
  return out;
}

// One single-quoted word of the pane's shell command.
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const tmuxRuntime: ConversationRuntime = {
  id: "tmux",

  async list(): Promise<Map<string, RuntimeInfo>> {
    return describePanes(await listPanes());
  },

  async inspect(ids: readonly string[]): Promise<Map<string, RuntimeInfo>> {
    // One `list-panes` for the whole batch (tmux has no cheaper per-session
    // query), then only the asked-for panes are resolved and probed.
    const panes = await listPanes();
    const wanted = new Map<string, TmuxPane>();
    for (const id of ids) {
      const pane = panes.get(id);
      if (pane) wanted.set(id, pane);
    }
    return describePanes(wanted);
  },

  subscribe(onSignal: (signal: RuntimeSignal) => void) {
    return subscribeTmuxSignals(onSignal);
  },

  async isRunning(conversationId: string): Promise<boolean> {
    // `tmux has-session -t <id>` exits 0 iff a session by that name exists.
    const exit = await Bun.spawn([TMUX, "has-session", "-t", conversationId], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    return exit === 0;
  },

  async create(
    conversationId: string,
    cwd: string,
    launch: LaunchFragment,
    opts?: {
      prompt?: string;
      model?: ConversationModel;
      effort?: EffortLevel;
      resumeSessionId?: string;
      forkSession?: boolean;
    },
  ): Promise<void> {
    // Idempotent under durable-job retry: if a live session already exists (a
    // retry after a crash between `new-session` and the job commit), do nothing.
    // `tmux new-session -s <id>` refuses a duplicate name, so a non-idempotent
    // retry would loop forever on the duplicate error.
    if (await this.isRunning(conversationId)) return;

    // Looked up now, and a missing CLI throws HERE (ClaudeCodeUnavailableError)
    // rather than starting a pane whose shell prints `command not found` and
    // dies — tmux itself would report success.
    const claudeBin = requireClaudeBin();

    // SINGULARITY_CONVERSATION_ID is read by the .githooks/prepare-commit-msg
    // hook so any `git commit` made inside the pane gets stamped with a
    // Singularity-Conversation trailer. SINGULARITY_PARENT_HOST is the
    // namespace Claude's .mcp.json dials back to over HTTP — it must be a host
    // the gateway actually routes, so it is this backend's own declared
    // runtime namespace rather than a caller-supplied label. runtimeNamespace()
    // throws when the process never declared one.
    //
    // CLAUDE_CODE_DISABLE_AGENT_VIEW pins the session to this pane. Claude
    // Code's agent view can otherwise move a live session into its per-machine
    // background daemon (`←` on an empty prompt, `/background`, the exit
    // dialog), and the daemon hands every session it hosts ITS OWN environment
    // — the one of whichever pane first spawned it. A session moved that way
    // keeps working through a stub in this pane, so the app cannot tell, but
    // its commits, pushes and MCP calls then carry another conversation's id
    // (the Sep 9 misattributed push). The app never uses background sessions,
    // so the pane is the only place a session may run.
    // The launch message, escaped so the CLI reads it as a turn and never as a
    // slash command (see launch-message.ts). Every use below reads this one
    // value, so the temp-file and positional paths cannot diverge.
    const launchMessage =
      typeof opts?.prompt === "string" && opts.prompt.length > 0
        ? asLaunchMessage(opts.prompt)
        : undefined;
    const parentHost = runtimeNamespace();
    const cliFlag = opts?.model ? cliFlagFor(opts.model) : undefined;
    // Thinking mode: levels low..max ride `--effort <flag>`; `ultracode` is not a
    // valid flag value, so it rides `--settings '{"ultracode":true}'` (xhigh +
    // dynamic-workflow orchestration). At most one channel is set per level.
    const effortFlag = opts?.effort
      ? resolveEffortFlag(opts.effort)
      : undefined;
    // One `--settings` object for the whole launch: the thinking mode (if any),
    // the fixed CLI preferences, the question hooks that touch this conversation's signal file (see
    // launch-settings.ts) and the workspace's fragment. Resume launches through
    // here too, so a resumed session gets the hooks as well.
    const settings = mergeLaunchSettings(
      opts?.effort ? resolveEffortSettings(opts.effort) : undefined,
      LAUNCH_CLI_SETTINGS,
      launchHookSettings({
        signalDir: tmuxSignalsDir.ensure(),
        relay: relayHookEntry(),
      }),
      launch.settings,
    );
    const claudeBase = [
      // Single-quoted: the path is spliced into the pane's shell command.
      shellWord(claudeBin),
      cliFlag && `--model ${cliFlag}`,
      effortFlag && `--effort ${effortFlag}`,
      // Single-quoted JSON; settingsFlag throws on a value carrying a quote.
      settingsFlag(settings),
      // The workspace's own arguments, each its own shell word.
      ...launch.argv.map(shellWord),
    ]
      .filter(Boolean)
      .join(" ");
    const cmdParts: string[] = [claudeBase];
    if (opts?.resumeSessionId) {
      cmdParts.push(`--resume ${opts.resumeSessionId}`);
      if (opts.forkSession) cmdParts.push("--fork-session");
    }

    // tmux has a ~16KB per-arg cap. For long prompts, write to a temp file and
    // have the shell script cat+delete it. Short prompts use positional $1.
    const PROMPT_ARG_LIMIT = 12_000;
    const useTempFile =
      launchMessage !== undefined && launchMessage.length > PROMPT_ARG_LIMIT;
    let promptFile: string | undefined;
    if (useTempFile) {
      promptFile = `/tmp/singularity-prompt-${conversationId}.txt`;
      await Bun.write(promptFile, launchMessage);
    }

    if (launchMessage !== undefined) {
      if (useTempFile) {
        cmdParts.push(`-- "$(cat '${promptFile}' && rm -f '${promptFile}')"`);
      } else {
        cmdParts.push(`-- "$1"`);
      }
    }
    // Demote the whole agent subtree (claude + everything it spawns: builds,
    // tests, git) below the interactive backends. The prefix must live in the
    // session command STRING: the pane process is forked by the shared tmux
    // SERVER, so demoting our short-lived `tmux new-session` client below
    // would be a no-op. backgroundPrefix() is a fixed literal — shell-safe.
    const claudeCmd = backgroundPrefix() + cmdParts.join(" ");
    // tmux execs this argv directly, so the first zsh is the only process that
    // can expand `$VAR` against what tmux hands the pane (its injected TMUX /
    // TMUX_PANE plus the two `-e` values). That shell immediately re-execs into
    // an allowlisted environment; see agent-session-env.ts for why the pane's
    // inherited environment cannot be trusted. The Claude command and the
    // prompt ride as positional words, never interpolated into the wrapper.
    const proc = Bun.spawn(
      [
        TMUX,
        "-u",
        "new-session",
        "-d",
        "-s",
        conversationId,
        "-c",
        cwd,
        "-e",
        `SINGULARITY_CONVERSATION_ID=${conversationId}`,
        "-e",
        `SINGULARITY_PARENT_HOST=${parentHost}`,
        "-e",
        "CLAUDE_CODE_DISABLE_AGENT_VIEW=1",
        "zsh",
        "-l",
        "-c",
        AGENT_SESSION_WRAPPER,
        "zsh",
        claudeCmd,
        ...(launchMessage !== undefined && !useTempFile ? [launchMessage] : []),
        // Re-arm the global session hooks in the same invocation: a tmux server
        // this `new-session` just started has none (see tmux-hooks.ts).
        ...chainedTmuxHookArgs(),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exit] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) {
      throw new Error(
        `tmux new-session for ${conversationId} failed (exit ${exit}): ${stderr.trim() || "<no stderr>"}`,
      );
    }
  },

  async delete(conversationId: string): Promise<void> {
    await Bun.spawn([TMUX, "kill-session", "-t", conversationId], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  },

  async interrupt(conversationId: string): Promise<void> {
    // Escape interrupts Claude Code's current operation (same as pressing
    // Esc in the TUI). Exit copy mode first so the key reaches Claude
    // rather than tmux's vi bindings (see send() for the same rationale).
    await Bun.spawn([TMUX, "copy-mode", "-q", "-t", conversationId], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn([TMUX, "send-keys", "-t", conversationId, "Escape"], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  },

  async send(conversationId: string, text: string): Promise<void> {
    // Exit copy mode if the pane is in it (e.g. user scrolled up before
    // clicking Push & Exit). copy-mode -q is a no-op when already in normal
    // mode. Without this, send-keys goes to copy mode's vi key bindings
    // instead of the running process — 'f' triggers "Jump to char", consuming
    // the rest of the prompt without it ever reaching Claude.
    await Bun.spawn([TMUX, "copy-mode", "-q", "-t", conversationId], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    // Clear a partial draft ONLY when the input box actually holds one, asking
    // the box directly via captureInputDraft (the same trusted read typeTurn
    // uses to verify submission). C-c is the CLI's "abort current line": at an
    // idle prompt it discards the draft harmlessly, but sent into a WORKING
    // agent it interrupts the streaming response and STOPS it. So it must never
    // reach a working agent — and the old `!paneIsWorking()` gate could not
    // guarantee that: a process-tree heuristic with false-negatives plus a
    // check→send race would occasionally fire C-c into a live agent (the
    // regular-prompt "agent stopped" bug). A web-driven send leaves the terminal
    // input empty, so this reads "" and sends no C-c; C-c fires only for a
    // genuine hand-typed draft — exactly the text typeTurn would append to.
    if (await captureInputDraft(conversationId)) {
      await Bun.spawn([TMUX, "send-keys", "-t", conversationId, "C-c"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
    }
    // Typed keystrokes + a verified Enter (see typeTurn).
    await typeTurn(conversationId, text);
  },

  async answerPrompt(conversationId: string, text: string): Promise<void> {
    // Dismiss the active prompt form, wait until it has actually cleared, then
    // send `text` as a turn. The wait is the whole point: Escape does not clear
    // the form instantly (the TUI re-renders to the idle input in ~210ms), and
    // pasting into a still-live menu makes it auto-select a wrong option and
    // fabricate an answer — losing the user's text. See ConversationRuntime
    // interface docs.

    // 0. The question may be known before its menu is drawn (see
    //    awaitPromptMenu). If no menu ever appears there is nothing to dismiss
    //    and the pane is already at its idle input.
    // 1+2. Dismiss the form, RE-SENDING Escape until it actually clears (throws
    //    if it never does). See escapeUntilPromptCleared() for the full
    //    self-healing rationale.
    if (await awaitPromptMenu(conversationId)) {
      await escapeUntilPromptCleared(conversationId);
    }

    // 3. Type + Enter. We deliberately do NOT C-c first: the answer text comes
    //    from the web form, so the terminal input line is empty (no draft to
    //    clear), and an unconditional C-c here could interrupt/kill a running
    //    agent — the same hazard send() avoids by clearing only a genuine draft
    //    (captureInputDraft). The menu is already dismissed, so typeTurn writes
    //    into the idle prompt.
    await typeTurn(conversationId, text);
  },

  waitUntilReady(conversationId: string, signal: AbortSignal) {
    return waitForInputReady(conversationId, signal);
  },

  async flushInteractivePrompt(conversationId: string): Promise<void> {
    // Dismiss the live prompt menu (e.g. AskUserQuestion) WITHOUT sending an
    // answer. Cancelling the menu forces the CLI to flush the buffered
    // assistant tool_use to the JSONL transcript so the web UI can render it.
    // This is exactly answerPrompt()'s self-healing Escape loop minus the
    // C-c + type step — no answer text is ever sent. A menu that never appears
    // (already answered in the terminal) leaves nothing to flush.
    if (await awaitPromptMenu(conversationId)) {
      await escapeUntilPromptCleared(conversationId);
    }
  },

  answerMenu: answerOpenMenu,
};
