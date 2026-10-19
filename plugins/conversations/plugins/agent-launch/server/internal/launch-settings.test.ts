import { describe, expect, test } from "bun:test";
import { resolveEffortSettings } from "@plugins/conversations/plugins/effort-provider/core";
import type { CompactionHookEntry } from "@plugins/conversations/plugins/compaction-context/core";
import {
  agentLaunchHooks,
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
} from "./launch-settings";

// The entry as compaction-context builds it (its own tests pin the builder).
const COMPACTION: CompactionHookEntry = {
  type: "command",
  command: 'bun "/srv/checkout/plugins/c/bin/compaction-context.ts"',
  timeout: 60,
};

describe("launch settings", () => {
  test("disables prompt suggestions, whose side query can call AskUserQuestion", () => {
    const merged = mergeLaunchSettings(LAUNCH_CLI_SETTINGS, { hooks: {} });
    expect(merged.promptSuggestionEnabled).toBe(false);
  });

  test("merges the thinking mode with other fragments in one object", () => {
    const merged = mergeLaunchSettings(resolveEffortSettings("ultracode"), {
      hooks: {},
    });
    expect(merged).toEqual({ ultracode: true, hooks: {} });
  });

  test("a level without settings contributes nothing", () => {
    expect(
      mergeLaunchSettings(resolveEffortSettings("high"), { a: 1 }),
    ).toEqual({ a: 1 });
  });

  test("two fragments setting one key throw", () => {
    expect(() => mergeLaunchSettings({ hooks: {} }, { hooks: {} })).toThrow(
      /both set "hooks"/,
    );
  });
});

describe("agentLaunchHooks", () => {
  test("the compaction hook runs on SessionStart's compact source only", () => {
    expect(agentLaunchHooks({ compaction: COMPACTION })).toEqual({
      SessionStart: [{ matcher: "compact", hooks: [COMPACTION] }],
    });
  });
});
