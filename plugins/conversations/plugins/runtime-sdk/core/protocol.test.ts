import { describe, expect, test } from "bun:test";
import { AgentLaunchOptionsSchema } from "./protocol";

const file = {
  cwd: "/w",
  claudeBin: "/bin/claude",
  model: null,
  effort: null,
  settings: {},
  settingSources: ["user", "project", "local"],
  mcpServers: null,
  strictMcpConfig: false,
  resume: null,
  resumeAt: null,
  resumeDropsTurn: null,
  fork: false,
  sessionId: "s",
  prompt: null,
};

describe("AgentLaunchOptionsSchema", () => {
  test("an options file written before launches named a guards root reads with its cwd as the root", () => {
    expect(AgentLaunchOptionsSchema.parse(file).guardsRoot).toBe("/w");
  });

  test("a named guards root is kept", () => {
    expect(
      AgentLaunchOptionsSchema.parse({ ...file, guardsRoot: "/repo" })
        .guardsRoot,
    ).toBe("/repo");
  });
});
