import { describe, expect, test } from "bun:test";
import { scratchLaunchFragment } from "./launch-fragment";

const URL = "http://equin.localhost:9000/api/mcp/conv-1";
const ROOT = "/repo";

describe("scratchLaunchFragment", () => {
  test("user + the dir's own sources, and only the app's MCP server", () => {
    const fragment = scratchLaunchFragment({ mcpUrl: URL, guardsRoot: ROOT });
    expect(fragment.settingSources).toEqual(["user", "project"]);
    expect(fragment.mcpServers).toEqual({ equin: { type: "http", url: URL } });
    expect(fragment.strictMcpConfig).toBe(true);
  });

  test("the profile's permissions ride the typed field, never settings", () => {
    const permissions = { allow: ["Bash", "Read"], deny: ["WebFetch"] };
    const fragment = scratchLaunchFragment({
      mcpUrl: URL,
      guardsRoot: ROOT,
      permissions,
    });
    expect(fragment.permissions).toEqual(permissions);
    expect(fragment.settings).toEqual({});
    expect(
      scratchLaunchFragment({ mcpUrl: URL, guardsRoot: ROOT }).permissions,
    ).toBeUndefined();
  });

  test("the agent's guards run from the launching checkout", () => {
    // Every guard — macos-automation included — rides the launch's agent
    // policy, so the fragment needs no deny-list copy of any of them.
    expect(
      scratchLaunchFragment({ mcpUrl: URL, guardsRoot: ROOT }).guardsRoot,
    ).toBe(ROOT);
  });

  test("a sandboxed profile's Bash cannot leave the sandbox", () => {
    const fragment = scratchLaunchFragment({
      mcpUrl: URL,
      guardsRoot: ROOT,
      permissions: { deny: ["Write"] },
      sandbox: true,
    });
    expect(fragment.settings).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      },
    });
    expect(fragment.permissions).toEqual({ deny: ["Write"] });
  });
});
