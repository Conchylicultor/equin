/**
 * Pure classification of a Claude Code pane capture into "which interactive
 * menu, if any, is open right now". No tmux / I/O here on purpose — deciding a
 * LIVE menu from a footer left behind in scrollback is the correctness-critical
 * part (a false positive fires Escape into a working agent), so it is unit
 * tested in pane-menu.test.ts. tmux-runtime.ts owns the capture and passes the
 * raw text through here.
 *
 * Why screen-scrape at all: the CLI's own session file does not distinguish a
 * blocked AskUserQuestion from an ordinary idle wait. It has reported
 * `waitingFor: "permission prompt"` (v2.1.159) and `waitingFor: "input needed"`
 * (v2.1.276) for the very same open question menu, and both spellings are what
 * it writes when nothing is on screen at all. The menu's own footer is the only
 * signal that separates them.
 */

import type { TerminalMenu } from "@plugins/conversations/plugins/terminal-menu/core";

// Every interactive menu footer — question OR rewind — terminates in the
// segment "Esc to cancel". Finding it is step one; step two is proving the menu
// it belongs to is still on screen (see composerBelow).
const FOOTER_TERMINATOR_RE = /Esc to cancel\b/i;

// A long footer HARD-WRAPS across terminal lines: extra control segments
// ("· n to add notes · Tab to switch questions ·") widen it past the pane and
// push "Esc to cancel" onto its own line, so the control anchors no longer
// share one physical line. The CLI emits the break itself (tmux's `-J`
// wrap-join does not rejoin it), so we rejoin the last few lines into one
// logical footer before matching. Bounded so the rejoin window can never reach
// past the wrapped footer into the menu body above it.
const FOOTER_MAX_WRAP_LINES = 3;

// The AskUserQuestion menu's footer. All three control segments required, in
// order, against the rejoined footer (NOT a loose substring). A working agent
// can legitimately STREAM the words "enter to select" in its own prose, but
// reproducing the whole fixed control string verbatim —
//   "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
// — is practically impossible. `.*` between segments tolerates separator/glyph
// drift across CLI versions (v2.1.161 wrote "↑/↓ to navigate", v2.1.276 writes
// "Tab/Arrow keys to navigate"). Case-insensitive only as a cheap hedge; the
// structure is what carries the weight.
const QUESTION_FOOTER_RE =
  /Enter to select\b.*\bto navigate\b.*\bEsc to cancel\b/i;

// Claude's *rewind* menu (opened by Esc-Esc at the idle prompt). It does NOT
// share the question footer — verified against CLI v2.1.161 it renders
// "Enter to continue · Esc to cancel" plus a "Restore the code…" header. Same
// ordered anchoring so streamed prose containing "enter to continue" cannot
// trip it. We detect it so escapeUntilPromptCleared() can treat it as a menu to
// dismiss rather than mistaking it for the idle prompt (which would strand it).
const REWIND_FOOTER_RE = /Enter to continue\b.*\bEsc to cancel\b/i;

// The CLI's composer — the input box it draws at the foot of the pane:
//
//   ───────────────────────────────────
//   ❯ …
//   ───────────────────────────────────
//     ⏵⏵ auto mode on · esc to interrupt
//
// THIS is the discriminator. The composer is rendered whenever no modal menu is
// open — idle, and mid-stream too, since you can type while the agent works —
// and a menu REPLACES it for as long as it is up. So a footer with a composer
// anywhere below it belongs to a menu that is already gone, and a footer with
// no composer below it belongs to one still on screen.
//
// It replaces an earlier rule that required the footer to be the bottom-most
// content line, over an allowlist of the chrome the CLI draws beneath a menu
// (blank rows, the spinner status line, "⎿ Tip:" hints). That allowlist was a
// closed guess at an open set, and it silently went stale the moment the CLI
// grew one more bottom notice: a peer "› Message from @… (ctrl+o to expand)"
// banner below an open menu made every question on that pane read as idle, so
// no answer form ever appeared and "Answer here" pressed no Escape. Crossing
// unknown lines is the safe direction — the composer is one fixed thing, and
// anything else below the footer is by definition not the composer.
const COMPOSER_RE = /^\s*(?:❯|[─━]{8,})/u;

// A numbered option line of any menu: "❯ 1. Stop and wait…" (the cursor on
// it) or "  2. Wait here, then…". Checked BEFORE the composer rule, whose `❯`
// prefix an option line under the cursor also carries.
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/u;

// A horizontal rule the CLI draws between blocks — chrome, never content.
const RULE_RE = /^\s*[─━]{8,}\s*$/u;

// A dashed rule — the CLI's divider INSIDE a dialog (Ink's dashed border,
// U+254C), e.g. around a permission prompt's command. Chrome, dropped from the
// body; it does not end it the way the dialog's solid top border does.
const DASHED_RULE_RE = /^\s*╌{8,}\s*$/u;

// A dialog's left border glyph, stripped from a body line.
const SIDE_BORDER_RE = /^(\s*)[│┃╎╏▎▏] ?/u;

// The permission prompt's countdown notice ("⚠ Claude Code will automatically
// deny this request in 1:21, to avoid blocking progress on an unattended
// session"). It ticks every second, so keeping it in the body would make every
// read a different menu — and refuse every answer as "the menu changed".
const COUNTDOWN_RE = /will automatically deny this request in\b/;

// How far above the footer a menu's options may start. Bounds the walk so
// numbered prose far up the scrollback can never be read as a menu.
const MENU_MAX_LINES = 40;

// How far above the title a dialog's top border may be. A body is read only
// between the two, so no border within reach means no body — never a guess at
// where unbounded scrollback stops being the question.
const BODY_MAX_LINES = 40;

export type PaneMenu =
  | { kind: "idle" }
  | { kind: "question" }
  | { kind: "rewind" }
  /** Any other numbered menu, read in full so the web can answer it. */
  | { kind: "menu"; menu: TerminalMenu };

/**
 * Which interactive menu (if any) is on screen in this pane capture.
 *
 * Walks UP from the bottom to the nearest footer terminator. Crossing a
 * composer line on the way means the footer is scrollback from a menu that has
 * already been answered, so the pane is idle. A live footer that is neither the
 * question's nor the rewind's is read as a numbered menu; one whose options
 * cannot be read is left `idle` rather than guessed at.
 */
export function classifyPaneText(paneText: string): PaneMenu {
  const lines = paneText.split("\n");
  const end = liveFooterEnd(lines);
  if (end == null) return { kind: "idle" };
  const footer = rejoinFooter(lines, end);
  if (QUESTION_FOOTER_RE.test(footer)) return { kind: "question" };
  if (REWIND_FOOTER_RE.test(footer)) return { kind: "rewind" };
  const menu = readNumberedMenu(lines, end);
  return menu ? { kind: "menu", menu } : { kind: "idle" };
}

/** Index of the open menu's footer terminator line, or null if none is open. */
function liveFooterEnd(lines: readonly string[]): number | null {
  let end = lines.length - 1;
  while (end >= 0 && !FOOTER_TERMINATOR_RE.test(lines[end]!)) {
    if (COMPOSER_RE.test(lines[end]!)) return null;
    end--;
  }
  return end < 0 ? null : end;
}

/** The footer ending at `end`, rejoined across its hard wraps into one line. */
function rejoinFooter(lines: readonly string[], end: number): string {
  const start = Math.max(0, end + 1 - FOOTER_MAX_WRAP_LINES);
  return squash(lines.slice(start, end + 1).join(" "));
}

/**
 * The numbered menu whose footer ends at `end`: the footer's own lines (the
 * terminator and the `·`-separated hint lines wrapped above it), the options
 * above them — each option's indented lines below it are its description — and
 * the title, the first content line above option 1.
 *
 * Null unless the options read as 1..k in order with the cursor on one of them:
 * anything less is not a menu this can answer safely.
 */
function readNumberedMenu(
  lines: readonly string[],
  end: number,
): TerminalMenu | null {
  let footerStart = end;
  while (
    footerStart > 0 &&
    end - footerStart + 1 < FOOTER_MAX_WRAP_LINES &&
    lines[footerStart - 1]!.includes("·") &&
    !OPTION_RE.test(lines[footerStart - 1]!)
  )
    footerStart--;
  const footer = squash(lines.slice(footerStart, end + 1).join(" "));

  // Walk up to option 1, keeping the lines in between (bottom-up).
  const body: string[] = [];
  let first: number | null = null;
  for (
    let i = footerStart - 1;
    i >= 0 && footerStart - i <= MENU_MAX_LINES;
    i--
  ) {
    const line = lines[i]!;
    body.push(line);
    const option = OPTION_RE.exec(line);
    if (option?.[2] === "1") {
      first = i;
      break;
    }
    if (!option && COMPOSER_RE.test(line) && !RULE_RE.test(line)) return null;
  }
  if (first === null) return null;
  const i = first;

  // The title: the nearest content line above option 1.
  let title = "";
  let titleAt = i;
  for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
    const line = lines[j]!;
    if (line.trim() === "") continue;
    if (!RULE_RE.test(line) && !COMPOSER_RE.test(line)) {
      title = squash(line);
      titleAt = j;
    }
    break;
  }

  const options: TerminalMenu["options"] = [];
  let highlighted: number | null = null;
  for (const line of body.reverse()) {
    const option = OPTION_RE.exec(line);
    if (option) {
      const n = Number(option[2]);
      if (n !== options.length + 1) return null;
      if (option[1]) highlighted = n;
      options.push({ n, label: squash(option[3]!), description: null });
      continue;
    }
    if (line.trim() === "" || RULE_RE.test(line)) continue;
    const last = options.at(-1)!;
    last.description = last.description
      ? `${last.description} ${squash(line)}`
      : squash(line);
  }
  if (highlighted === null) return null;
  const asked = title ? readBody(lines, titleAt) : "";
  return { title, body: asked, options, highlighted, footer };
}

/**
 * The dialog content above the title at `titleAt`: the lines up to the solid
 * rule that is the dialog's top border, without its chrome (dashed dividers,
 * the side border, the countdown notice), dedented, blank runs collapsed.
 * "" when no top border is within reach.
 */
function readBody(lines: readonly string[], titleAt: number): string {
  let top: number | null = null;
  for (let j = titleAt - 1; j >= 0 && titleAt - j <= BODY_MAX_LINES; j--) {
    if (RULE_RE.test(lines[j]!)) {
      top = j;
      break;
    }
  }
  if (top === null) return "";

  const kept: string[] = [];
  let inCountdown = false;
  for (const raw of lines.slice(top + 1, titleAt)) {
    const line = raw.replace(SIDE_BORDER_RE, "$1").trimEnd();
    if (DASHED_RULE_RE.test(line)) continue;
    // The notice hard-wraps; it runs to the next blank line.
    if (COUNTDOWN_RE.test(line)) inCountdown = true;
    if (inCountdown) {
      if (line === "") inCountdown = false;
      continue;
    }
    if (line === "" && (kept.length === 0 || kept.at(-1) === "")) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();

  const indent = Math.min(
    ...kept.filter((l) => l !== "").map((l) => /^ */.exec(l)![0].length),
  );
  return kept.map((l) => l.slice(indent)).join("\n");
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
