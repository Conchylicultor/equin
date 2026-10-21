import { describe, expect, test } from "bun:test";
import { rewindRelaunchOptions, sdkLaunchOptions } from "./launch-options";

const base = {
  cwd: "/w",
  claudeBin: "/bin/claude",
  hooks: { SessionStart: [{ matcher: "compact", hooks: [] }] },
};

describe("sdkLaunchOptions", () => {
  test("a worktree launch: the CLI's default sources, no MCP override", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: { settings: {} },
      prompt: "hi",
    });
    expect(o).toMatchObject({
      cwd: "/w",
      claudeBin: "/bin/claude",
      settingSources: ["user", "project", "local"],
      mcpServers: null,
      strictMcpConfig: false,
      resume: null,
      fork: false,
      prompt: "hi",
      model: null,
      effort: null,
    });
    expect(o.settings).toEqual({
      promptSuggestionEnabled: false,
      hooks: base.hooks,
    });
  });

  test("a scratch fragment maps onto the SDK's own options one to one", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: {
        settingSources: ["project"],
        mcpServers: { equin: { type: "http", url: "http://x/mcp" } },
        strictMcpConfig: true,
        settings: { permissions: { deny: ["Bash"] } },
      },
    });
    expect(o.settingSources).toEqual(["project"]);
    expect(o.mcpServers).toEqual({
      equin: { type: "http", url: "http://x/mcp" },
    });
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settings.permissions).toEqual({ deny: ["Bash"] });
    expect(o.prompt).toBeNull();
  });

  test("instructions ride the system prompt, not the first turn", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: { settings: {} },
      prompt: "hi",
      appendSystemPrompt: "be terse",
    });
    expect(o).toMatchObject({ prompt: "hi", appendSystemPrompt: "be terse" });
    expect(
      sdkLaunchOptions({ ...base, launch: { settings: {} } })
        .appendSystemPrompt,
    ).toBeNull();
  });

  test("a fragment setting a key the launch already sets throws", () => {
    expect(() =>
      sdkLaunchOptions({ ...base, launch: { settings: { hooks: {} } } }),
    ).toThrow(/hooks/);
  });

  test("resume and fork", () => {
    const o = sdkLaunchOptions({
      ...base,
      launch: { settings: {} },
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
      launch: { settings: {} },
      resumeSessionId: "sid",
    });
    expect(resumed.sessionId).toBe("sid");
    const fresh = sdkLaunchOptions({ ...base, launch: { settings: {} } });
    expect(fresh.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("rewindRelaunchOptions", () => {
  const prev = sdkLaunchOptions({
    ...base,
    launch: { settings: {} },
    prompt: "first",
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
