import { describe, expect, test } from "bun:test";
import { resolveEffortSettings } from "@plugins/conversations/plugins/effort-provider/core";
import type { CompactionHookEntry } from "@plugins/conversations/plugins/compaction-context/core";
import type { RelayHookEntry } from "@plugins/conversations/plugins/question-relay/core";
import type { PromptSubmitHookEntry } from "@plugins/conversations/plugins/turn-ledger/server";
import {
  LAUNCH_CLI_SETTINGS,
  launchHookSettings,
  mergeLaunchSettings,
  settingsFlag,
} from "./launch-settings";

const DIR = "/srv/data/state/tmux-signals";
const SCRIPT = "/srv/checkout/plugins/q/bin/ask-relay.ts";
// The entry as question-relay builds it (its own tests pin the builder).
const RELAY: RelayHookEntry = {
  type: "command",
  command: `bun "${SCRIPT}"`,
  timeout: 2_000_000,
  statusMessage: "Waiting for your answer in Singularity…",
};

// The entry as turn-ledger builds it (its own tests pin the builder).
const PROMPT_SUBMIT: PromptSubmitHookEntry = {
  type: "command",
  command: 'cat > "/srv/data/state/prompt-submits/x.json"; exit 0',
};

// The entry as compaction-context builds it (its own tests pin the builder).
const COMPACTION: CompactionHookEntry = {
  type: "command",
  command: 'bun "/srv/checkout/plugins/c/bin/compaction-context.ts"',
  timeout: 60,
};

function hooks(signalDir = DIR) {
  return launchHookSettings({
    signalDir,
    relay: RELAY,
    promptSubmit: PROMPT_SUBMIT,
    compaction: COMPACTION,
  });
}

const TOUCH = {
  type: "command",
  command: `touch "${DIR}/$SINGULARITY_CONVERSATION_ID"`,
};

describe("launch settings", () => {
  test("disables prompt suggestions, whose side query can call AskUserQuestion", () => {
    const merged = mergeLaunchSettings(LAUNCH_CLI_SETTINGS, hooks());
    expect(merged.promptSuggestionEnabled).toBe(false);
  });

  test("merges the thinking mode with the question hooks in one object", () => {
    const merged = mergeLaunchSettings(
      resolveEffortSettings("ultracode"),
      hooks(),
    );
    expect(merged.ultracode).toBe(true);
    const h = merged.hooks as Record<string, unknown[]>;
    expect(Object.keys(h).sort()).toEqual([
      "Notification",
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(h.PostToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [TOUCH] },
    ]);
  });

  test("the relay holds the question beside the touch, on one matcher", () => {
    const h = hooks().hooks as Record<string, unknown[]>;
    expect(h.PreToolUse).toEqual([
      {
        matcher: "AskUserQuestion",
        hooks: [
          TOUCH,
          {
            type: "command",
            command: `bun "${SCRIPT}"`,
            timeout: 2_000_000,
            statusMessage: "Waiting for your answer in Singularity…",
          },
        ],
      },
    ]);
  });

  test("the compaction hook runs on SessionStart's compact source only", () => {
    const h = hooks().hooks as Record<string, unknown[]>;
    expect(h.SessionStart).toEqual([
      { matcher: "compact", hooks: [COMPACTION] },
    ]);
  });

  test("the flag is single-quoted JSON that contains no single quote", () => {
    const flag = settingsFlag(
      mergeLaunchSettings(resolveEffortSettings("ultracode"), hooks()),
    );
    const json = flag.slice("--settings '".length, -1);
    expect(flag.startsWith("--settings '")).toBe(true);
    expect(flag.endsWith("'")).toBe(true);
    expect(json.includes("'")).toBe(false);
    const parsed = JSON.parse(json);
    expect(parsed.hooks.UserPromptSubmit).toEqual([
      { hooks: [TOUCH, PROMPT_SUBMIT] },
    ]);
    expect(parsed.hooks.PreToolUse[0].hooks[1].command).toBe(`bun "${SCRIPT}"`);
  });

  test("a level without settings contributes nothing", () => {
    expect(mergeLaunchSettings(resolveEffortSettings("high"), hooks())).toEqual(
      hooks(),
    );
  });

  test("two fragments setting one key throw", () => {
    expect(() => mergeLaunchSettings({ hooks: {} }, hooks())).toThrow(
      /both set "hooks"/,
    );
  });

  test("a single quote in a value throws instead of breaking the quoting", () => {
    expect(() => settingsFlag({ x: "it's" })).toThrow(/single quote/);
  });

  test("a signal dir unsafe to splice into a command throws", () => {
    expect(() => hooks("/srv/o'brien/x")).toThrow(/cannot be spliced/);
  });
});
