import { describe, expect, test } from "bun:test";
import { classifyPaneText } from "./pane-menu";

const RULE = "─".repeat(70);

const kindOf = (text: string) => classifyPaneText(text).kind;

/** The composer box the CLI draws whenever no modal menu is open. */
const composer = (hint = "⏵⏵ auto mode on (shift+tab to cycle)") =>
  [RULE, "❯ ", RULE, `  ${hint}`].join("\n");

/** An open AskUserQuestion menu, footer last. */
const questionMenu = (footer: string) =>
  [
    "  ⏺ Planning the change now.",
    "",
    `⏴  ⏸ Scope  ⏸ Landing  ✔ Submit  ⏵`,
    "",
    "How wide should this plan be?",
    "",
    "❯ 1. Git journey only (Recommended)",
    "     Push becomes local-only without a writable remote.",
    RULE,
    "  2. Git journey + a first-run doctor",
    "  3. Type something.",
    "  4. Chat about this",
    "",
    footer,
  ].join("\n");

const QUESTION_FOOTER =
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const LEGACY_FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const REWIND_FOOTER = "Enter to continue · Esc to cancel";

describe("a menu that is on screen", () => {
  test("bare question footer at the very bottom", () => {
    expect(kindOf(questionMenu(QUESTION_FOOTER))).toBe("question");
  });

  test("the pre-v2.1.276 arrow-key footer still reads as a question", () => {
    expect(kindOf(questionMenu(LEGACY_FOOTER))).toBe("question");
  });

  test("trailing blank lines do not hide the footer", () => {
    expect(kindOf(`${questionMenu(QUESTION_FOOTER)}\n\n\n`)).toBe("question");
  });

  test("the spinner + tip chrome the old CLI drew below a menu", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "✶ Gallivanting… (19d 17h · ↓ 16.9k tokens)",
      "  ⎿  Tip: Use /statusline to set up a custom status line",
    ].join("\n");
    expect(kindOf(text)).toBe("question");
  });

  // The regression this file exists for: the CLI grew a peer-message banner
  // below the menu, and the old bottom-most-content-line rule read the whole
  // pane as idle.
  test("a peer-message banner below the footer", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "›  Message from @aa55e1f7474d9c347 (ctrl+o to expand)",
      "",
    ].join("\n");
    expect(kindOf(text)).toBe("question");
  });

  test("any unknown bottom notice the CLI may grow next", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "  ⚑ Something nobody has written a regex for yet",
      "  ⚑ …nor for this one",
    ].join("\n");
    expect(kindOf(text)).toBe("question");
  });

  test("a hard-wrapped footer is rejoined before matching", () => {
    const text = questionMenu(
      ["Enter to select · Tab/Arrow keys to navigate ·", "Esc to cancel"].join(
        "\n",
      ),
    );
    expect(kindOf(text)).toBe("question");
  });

  test("the rewind menu is a menu, not idle", () => {
    const text = [
      "Restore the code and the conversation to a previous point?",
      "",
      "❯ 1. Restore code and conversation",
      "  2. Restore conversation only",
      "",
      REWIND_FOOTER,
    ].join("\n");
    expect(kindOf(text)).toBe("rewind");
  });
});

describe("a footer left behind in scrollback", () => {
  test("answered question, agent now idle at the composer", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "⏺ Going with the git journey only.",
      "",
      composer(),
    ].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("answered question, agent mid-stream (composer still rendered)", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "✳ Zigzagging… (27s · thinking more)",
      "                                                    143149 tokens",
      composer("⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"),
    ].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("a stale rewind footer is idle too", () => {
    const text = [REWIND_FOOTER, "", composer()].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("the LIVE menu wins when a stale footer sits above it", () => {
    const text = [
      questionMenu(QUESTION_FOOTER),
      "",
      "⏺ Answered. Asking the next one.",
      "",
      composer(),
      questionMenu(QUESTION_FOOTER),
    ].join("\n");
    expect(kindOf(text)).toBe("question");
  });
});

describe("no menu at all", () => {
  test("plain idle pane", () => {
    expect(kindOf(["⏺ All done.", "", composer()].join("\n"))).toBe("idle");
  });

  test("empty capture", () => {
    expect(kindOf("")).toBe("idle");
  });

  // The footer's control string is fixed; prose merely quoting part of it must
  // not fabricate a menu, because a false positive fires Escape into a working
  // agent.
  test("prose quoting the control words is not a menu", () => {
    const text = [
      "⏺ The footer reads Enter to select and then you navigate with arrows;",
      "  pressing Esc to cancel backs out.",
      "",
      composer(),
    ].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("a terminator with no recognised head anchors is not a question", () => {
    expect(kindOf(["  Esc to cancel"].join("\n"))).toBe("idle");
  });
});

/** The usage-limit menu as CLI v2.1.3xx draws it (captured from a real pane). */
const limitMenu = (cursor = 1) =>
  [
    '● Agent "Implement grouping" failed: Agent terminated early due to an API',
    "  error: You've hit your weekly limit · resets Oct 13 at 6am (Europe/Paris)",
    "  ⎿ You've hit your weekly limit · resets Oct 13 at 6am (Europe/Paris)",
    "    Use your limit reset to reset it now: clau.de/reset",
    "",
    "✻ Cogitated for 1h 17m 56s · done 1:06 AM",
    RULE,
    "  What do you want to do?",
    "",
    ...[
      "Stop and wait for limit to reset",
      "Wait here, then continue automatically at Oct 13 at 6am",
      "Switch to usage credits",
    ].map((label, i) =>
      i + 1 === cursor ? `  ❯ ${i + 1}. ${label}` : `    ${i + 1}. ${label}`,
    ),
    "",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");

describe("any other numbered menu", () => {
  test("the usage-limit menu is read in full", () => {
    expect(classifyPaneText(limitMenu())).toEqual({
      kind: "menu",
      menu: {
        title: "What do you want to do?",
        body: "",
        options: [
          {
            n: 1,
            label: "Stop and wait for limit to reset",
            description: null,
          },
          {
            n: 2,
            label: "Wait here, then continue automatically at Oct 13 at 6am",
            description: null,
          },
          { n: 3, label: "Switch to usage credits", description: null },
        ],
        highlighted: 1,
        footer: "Enter to confirm · Esc to cancel",
      },
    });
  });

  test("the cursor on another option is the highlighted one", () => {
    const read = classifyPaneText(limitMenu(2));
    expect(read.kind === "menu" && read.menu.highlighted).toBe(2);
  });

  test("indented lines under an option are its description", () => {
    const text = [
      "Pick a model",
      "",
      "❯ 1. Default (recommended)",
      "     Opus for everything",
      "  2. Sonnet",
      "     Fast and capable",
      "     for daily work",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(classifyPaneText(text)).toEqual({
      kind: "menu",
      menu: {
        title: "Pick a model",
        body: "",
        options: [
          {
            n: 1,
            label: "Default (recommended)",
            description: "Opus for everything",
          },
          {
            n: 2,
            label: "Sonnet",
            description: "Fast and capable for daily work",
          },
        ],
        highlighted: 1,
        footer: "Enter to confirm · Esc to cancel",
      },
    });
  });

  test("a footer hard-wrapped across lines is rejoined", () => {
    const text = [
      "Choose",
      "❯ 1. One",
      "  2. Two",
      "Enter to confirm · Tab to amend ·",
      "Esc to cancel",
    ].join("\n");
    const read = classifyPaneText(text);
    expect(read.kind === "menu" && read.menu.footer).toBe(
      "Enter to confirm · Tab to amend · Esc to cancel",
    );
    expect(read.kind === "menu" && read.menu.options.length).toBe(2);
  });

  test("an answered menu above the composer is idle", () => {
    expect(kindOf([limitMenu(), "", composer()].join("\n"))).toBe("idle");
  });

  test("options not numbered from 1 in order are not a menu", () => {
    const text = ["Pick", "❯ 1. One", "  3. Three", "Esc to cancel"].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("a menu with no cursor is not answered", () => {
    const text = ["Pick", "  1. One", "  2. Two", "Esc to cancel"].join("\n");
    expect(kindOf(text)).toBe("idle");
  });

  test("a permission prompt's body is its command and reason, without chrome", () => {
    const dashed = "╌".repeat(40);
    const text = [
      "● Bash(earlier output)",
      "",
      RULE,
      " Bash command",
      " Screenshot the key",
      "",
      dashed,
      " │ S=/tmp/x; rm -f $S/*.png;",
      " │   ./singularity run shot.ts",
      dashed,
      " │ Dangerous rm operation on possibly-empty variable path",
      " ⚠ Claude Code will automatically deny this request in 1:21, to avoid blocking",
      " progress on an unattended session",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    const read = classifyPaneText(text);
    expect(read.kind === "menu" && read.menu.title).toBe(
      "Do you want to proceed?",
    );
    expect(read.kind === "menu" && read.menu.body).toBe(
      [
        "Bash command",
        "Screenshot the key",
        "",
        "S=/tmp/x; rm -f $S/*.png;",
        "  ./singularity run shot.ts",
        "Dangerous rm operation on possibly-empty variable path",
      ].join("\n"),
    );
  });

  test("the countdown ticking does not change the menu", () => {
    const at = (t: string) =>
      [
        RULE,
        " Bash command",
        ` ⚠ Claude Code will automatically deny this request in ${t}, to avoid`,
        "",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        " Esc to cancel",
      ].join("\n");
    expect(classifyPaneText(at("1:21"))).toEqual(classifyPaneText(at("1:20")));
  });

  test("no top border within reach means no body", () => {
    const text = ["prose", "Proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel"];
    const read = classifyPaneText(text.join("\n"));
    expect(read.kind === "menu" && read.menu.body).toBe("");
  });

  test("a footer with no options above it is idle", () => {
    expect(kindOf(["Some prose", "", "Esc to cancel"].join("\n"))).toBe("idle");
  });
});
