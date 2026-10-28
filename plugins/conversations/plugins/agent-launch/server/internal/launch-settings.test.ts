import { agentPolicySettings } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import { describe, expect, test } from "bun:test";
import { resolveEffortSettings } from "@plugins/conversations/plugins/effort-provider/core";
import type { CompactionHookEntry } from "@plugins/conversations/plugins/compaction-context/core";
import type { StopGateHookEntry } from "@plugins/conversations/plugins/stop-gate/core";
import {
  agentLaunchPolicy,
  LAUNCH_CLI_SETTINGS,
  mergeLaunchSettings,
} from "./launch-settings";

// The entry as compaction-context builds it (its own tests pin the builder).
const COMPACTION: CompactionHookEntry = {
  type: "command",
  command: 'bun "/srv/checkout/plugins/c/bin/compaction-context.ts"',
  timeout: 60,
};
// The entry as stop-gate builds it (its own tests pin the builder).
const STOP_GATE: StopGateHookEntry = {
  type: "command",
  command: 'bun "/srv/checkout/plugins/c/bin/stop-gate.ts"',
  timeout: 30,
};
const ENTRIES = { compaction: COMPACTION, stopGate: STOP_GATE };

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

describe("agentLaunchPolicy", () => {
  test("the compaction hook runs on SessionStart's compact source only", () => {
    expect(agentLaunchPolicy(ENTRIES).hooks.SessionStart).toEqual([
      { matcher: "compact", hooks: [COMPACTION] },
    ]);
  });

  test("the stop gate runs on every Stop", () => {
    expect(agentLaunchPolicy(ENTRIES).hooks.Stop).toEqual([
      { hooks: [STOP_GATE] },
    ]);
  });

  test("every launch carries the agent policy's hooks and deny rules", () => {
    const policy = agentPolicySettings();
    const launch = agentLaunchPolicy(ENTRIES);
    for (const [event, groups] of Object.entries(policy.hooks)) {
      expect(launch.hooks[event]).toEqual(groups);
    }
    expect(launch.permissions).toEqual(policy.permissions);
  });
});
