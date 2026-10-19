import { describe, expect, test } from "bun:test";
import { scratchLaunchFragment } from "./launch-fragment";

const URL = "http://singularity.localhost:9000/api/mcp/conv-1";

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
});
