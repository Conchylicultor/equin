import { describe, expect, test } from "bun:test";
import { scratchLaunchFragment } from "./launch-fragment";

const URL = "http://equin.localhost:9000/api/mcp/conv-1";

describe("scratchLaunchFragment", () => {
  test("user + the dir's own sources, and only the app's MCP server", () => {
    const fragment = scratchLaunchFragment({ mcpUrl: URL });
    expect(fragment.settingSources).toEqual(["user", "project"]);
    expect(fragment.mcpServers).toEqual({ equin: { type: "http", url: URL } });
    expect(fragment.strictMcpConfig).toBe(true);
  });

  test("the profile's permissions ride the settings fragment", () => {
    const permissions = { allow: ["Bash", "Read"], deny: ["WebFetch"] };
    expect(
      scratchLaunchFragment({ mcpUrl: URL, permissions }).settings,
    ).toEqual({ permissions });
    expect(scratchLaunchFragment({ mcpUrl: URL }).settings).toEqual({});
  });

  test("a sandboxed profile's Bash cannot leave the sandbox", () => {
    const settings = scratchLaunchFragment({
      mcpUrl: URL,
      permissions: { deny: ["Write"] },
      sandbox: true,
    }).settings;
    expect(settings).toEqual({
      permissions: { deny: ["Write"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      },
    });
  });
});
