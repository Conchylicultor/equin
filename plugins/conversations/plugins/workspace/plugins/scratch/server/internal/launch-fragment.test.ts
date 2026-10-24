import { describe, expect, test } from "bun:test";
import { scratchLaunchFragment } from "./launch-fragment";

/** The macOS automation deny rules every scratch session carries. */
const TCC_DENY = [
  "Bash(osascript:*)",
  "Bash(screencapture:*)",
  "Bash(automator:*)",
  "Bash(cliclick:*)",
  "Bash(peekaboo:*)",
  "Bash(shortcuts run:*)",
];

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
    ).toEqual({
      permissions: { allow: ["Bash", "Read"], deny: ["WebFetch", ...TCC_DENY] },
    });
  });

  test("macOS automation is denied even without a profile deny list", () => {
    expect(scratchLaunchFragment({ mcpUrl: URL }).settings).toEqual({
      permissions: { deny: TCC_DENY },
    });
  });

  test("a profile's own copy of a TCC rule is not repeated", () => {
    const permissions = { deny: ["Bash(osascript:*)", "WebFetch"] };
    expect(
      scratchLaunchFragment({ mcpUrl: URL, permissions }).settings,
    ).toEqual({
      permissions: {
        deny: ["Bash(osascript:*)", "WebFetch", ...TCC_DENY.slice(1)],
      },
    });
  });

  test("a sandboxed profile's Bash cannot leave the sandbox", () => {
    const settings = scratchLaunchFragment({
      mcpUrl: URL,
      permissions: { deny: ["Write"] },
      sandbox: true,
    }).settings;
    expect(settings).toEqual({
      permissions: { deny: ["Write", ...TCC_DENY] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      },
    });
  });
});
