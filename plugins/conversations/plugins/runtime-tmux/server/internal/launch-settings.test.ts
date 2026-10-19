import { describe, expect, test } from "bun:test";
import { resolveEffortSettings } from "@plugins/conversations/plugins/effort-provider/core";
import type { CompactionHookEntry } from "@plugins/conversations/plugins/compaction-context/core";
import { mergeLaunchSettings } from "@plugins/conversations/plugins/agent-launch/server";
import type { RelayHookEntry } from "@plugins/conversations/plugins/question-relay/core";
import type { PromptSubmitHookEntry } from "@plugins/conversations/plugins/turn-ledger/server";
import {
  launchFragmentArgv,
  launchHookSettings,
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
// What agent-launch's `agentLaunchHooks` hands every runtime.
const SHARED = {
  SessionStart: [{ matcher: "compact", hooks: [COMPACTION] }],
};

function hooks(signalDir = DIR) {
  return launchHookSettings({
    signalDir,
    relay: RELAY,
    promptSubmit: PROMPT_SUBMIT,
    shared: SHARED,
  });
}

const TOUCH = {
  type: "command",
  command: `touch "${DIR}/$SINGULARITY_CONVERSATION_ID"`,
};

describe("launch hook settings", () => {
  test("the pane's hooks sit beside the shared ones in one hooks map", () => {
    const h = hooks().hooks as Record<string, unknown[]>;
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
    expect(h.SessionStart).toEqual(SHARED.SessionStart);
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

  test("a shared hook on an event the pane also hooks throws", () => {
    expect(() =>
      launchHookSettings({
        signalDir: DIR,
        relay: RELAY,
        promptSubmit: PROMPT_SUBMIT,
        shared: { Notification: [] },
      }),
    ).toThrow(/both set "Notification"/);
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
    expect(parsed.ultracode).toBe(true);
    expect(parsed.hooks.UserPromptSubmit).toEqual([
      { hooks: [TOUCH, PROMPT_SUBMIT] },
    ]);
    expect(parsed.hooks.PreToolUse[0].hooks[1].command).toBe(`bun "${SCRIPT}"`);
  });

  test("a single quote in a value throws instead of breaking the quoting", () => {
    expect(() => settingsFlag({ x: "it's" })).toThrow(/single quote/);
  });

  test("a signal dir unsafe to splice into a command throws", () => {
    expect(() => hooks("/srv/o'brien/x")).toThrow(/cannot be spliced/);
  });
});

describe("launchFragmentArgv", () => {
  const URL = "http://singularity.localhost:9000/api/mcp/conv-1";

  test("an empty fragment adds no argument", () => {
    expect(launchFragmentArgv({ settings: {} })).toEqual([]);
  });

  test("setting sources, the MCP servers, then strict", () => {
    expect(
      launchFragmentArgv({
        settingSources: ["user", "project"],
        mcpServers: { equin: { type: "http", url: URL } },
        strictMcpConfig: true,
        settings: { permissions: { allow: ["Bash"] } },
      }),
    ).toEqual([
      "--setting-sources",
      "user,project",
      "--mcp-config",
      JSON.stringify({ mcpServers: { equin: { type: "http", url: URL } } }),
      "--strict-mcp-config",
    ]);
  });

  test("the variadic --mcp-config is never the last flag when strict is set", () => {
    const argv = launchFragmentArgv({
      mcpServers: { equin: { type: "http", url: URL } },
      strictMcpConfig: true,
      settings: {},
    });
    expect(argv.at(-1)).toBe("--strict-mcp-config");
  });
});
