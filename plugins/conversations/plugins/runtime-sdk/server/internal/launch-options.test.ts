import { describe, expect, test } from "bun:test";
import {
  agentPolicySettings,
  hookCommand,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import type { CompactionHookEntry } from "@plugins/conversations/plugins/compaction-context/core";
import type { StopGateHookEntry } from "@plugins/conversations/plugins/stop-gate/core";
import { rewindRelaunchOptions, sdkLaunchOptions } from "./launch-options";

const COMPACTION: CompactionHookEntry = {
  type: "command",
  command: hookCommand({ checkout: "/srv", script: "bin/compaction.ts" }),
  timeout: 60,
};
const STOP_GATE: StopGateHookEntry = {
  type: "command",
  command: hookCommand({ checkout: "/srv", script: "bin/stop-gate.ts" }),
  timeout: 30,
};
const OWN_HOOKS = {
  SessionStart: [{ matcher: "compact", hooks: [COMPACTION] }],
  Stop: [{ hooks: [STOP_GATE] }],
};

const base = {
  cwd: "/w",
  hookEntries: { compaction: COMPACTION, stopGate: STOP_GATE },
};
const CHECKOUT = { guards: { from: "checkout" }, settings: {} } as const;

describe("sdkLaunchOptions", () => {
  test("a worktree launch: the CLI's default sources, no MCP override", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: CHECKOUT,
      prompt: { turnId: "turn-1", text: "hi" },
    });
    expect(o).toMatchObject({
      cwd: "/w",
      settingSources: ["user", "project", "local"],
      mcpServers: null,
      strictMcpConfig: false,
      resume: null,
      fork: false,
      prompt: { turnId: "turn-1", text: "hi" },
      model: null,
      effort: null,
    });
    // The checkout's own settings carry the agent policy; the launch adds
    // only its own hooks, so the hook commands and their scripts share a commit.
    expect(o.guardsRoot).toBe("/w");
    expect(o.settings).toEqual({
      promptSuggestionEnabled: false,
      autoMemoryEnabled: false,
      hooks: OWN_HOOKS,
      permissions: { deny: [] },
    });
  });

  test("a checkout launch that does not load project settings throws: it would run unguarded", () => {
    expect(() =>
      sdkLaunchOptions({
        ...base,
        launch: { ...CHECKOUT, settingSources: ["user"] },
      }),
    ).toThrow(/unguarded/);
  });

  test("a scratch fragment maps onto the SDK's own options one to one", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: {
        settingSources: ["project"],
        mcpServers: { equin: { type: "http", url: "http://x/mcp" } },
        strictMcpConfig: true,
        permissions: { allow: ["Read"], deny: ["Bash"] },
        guards: { from: "launch", root: "/repo" },
        settings: {},
      },
    });
    const policy = agentPolicySettings();
    expect(o.settingSources).toEqual(["project"]);
    expect(o.mcpServers).toEqual({
      equin: { type: "http", url: "http://x/mcp" },
    });
    expect(o.strictMcpConfig).toBe(true);
    // The launch carries the agent policy: its hooks, and its deny rules
    // first with the workspace's added to them.
    expect(o.settings.hooks).toEqual({ ...policy.hooks, ...OWN_HOOKS });
    expect(o.settings.permissions).toEqual({
      allow: ["Read"],
      deny: [...policy.permissions.deny, "Bash"],
    });
    expect(o.guardsRoot).toBe("/repo");
    expect(o.prompt).toBeNull();
  });

  test("instructions ride the system prompt, not the first turn", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: CHECKOUT,
      prompt: { turnId: "turn-1", text: "hi" },
      appendSystemPrompt: "be terse",
    });
    expect(o).toMatchObject({
      prompt: { turnId: "turn-1", text: "hi" },
      appendSystemPrompt: "be terse",
    });
    expect(
      sdkLaunchOptions({ ...base, launch: CHECKOUT }).appendSystemPrompt,
    ).toBeNull();
  });

  test("a fragment setting a key the launch already sets throws", () => {
    expect(() =>
      sdkLaunchOptions({
        ...base,
        launch: { ...CHECKOUT, settings: { hooks: {} } },
      }),
    ).toThrow(/hooks/);
  });

  test("resume and fork", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: CHECKOUT,
      resumeSessionId: "sid",
      forkSession: true,
    });
    expect(o).toMatchObject({ resume: "sid", fork: true });
    // A fork runs under a new id, decided now.
    expect(o.sessionId).not.toBe("sid");
  });

  test("the session id is known at launch", () => {
    const resumed = sdkLaunchOptions({
      ...base,
      launch: CHECKOUT,
      resumeSessionId: "sid",
    });
    expect(resumed.sessionId).toBe("sid");
    const fresh = sdkLaunchOptions({
      ...base,
      launch: CHECKOUT,
    });
    expect(fresh.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("rewindRelaunchOptions", () => {
  const prev = sdkLaunchOptions({
    ...base,
    launch: CHECKOUT,
    prompt: { turnId: "turn-0", text: "first" },
    appendSystemPrompt: "be terse",
    forkSession: true,
    resumeSessionId: "src",
  });

  test("resumes at the message before the turn, dropping it", () => {
    expect(
      rewindRelaunchOptions(prev, {
        sessionId: "sid",
        anchorUuid: "a-1",
        promptUuid: "p-2",
      }),
    ).toMatchObject({
      resume: "sid",
      resumeAt: "a-1",
      resumeDropsTurn: "p-2",
      sessionId: "sid",
      fork: false,
      prompt: null,
      appendSystemPrompt: "be terse",
      cwd: "/w",
    });
  });

  test("the session's first turn: a fresh session", () => {
    expect(
      rewindRelaunchOptions(prev, {
        sessionId: "sid",
        anchorUuid: null,
        promptUuid: "p-1",
      }),
    ).toMatchObject({
      resume: null,
      resumeAt: null,
      resumeDropsTurn: null,
      prompt: null,
    });
  });

  test("a fresh session never reuses the stopped session's id", () => {
    const o = rewindRelaunchOptions(prev, {
      sessionId: "sid",
      anchorUuid: null,
      promptUuid: "p-1",
    });
    expect(o.sessionId).not.toBe("sid");
    expect(o.sessionId).not.toBe(prev.sessionId);
  });
});
