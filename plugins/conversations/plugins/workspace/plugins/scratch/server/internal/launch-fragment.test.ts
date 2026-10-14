import { describe, expect, test } from "bun:test";
import { scratchLaunchFragment } from "./launch-fragment";

const URL = "http://singularity.localhost:9000/api/mcp/conv-1";

describe("scratchLaunchFragment", () => {
  test("user + the dir's own sources, and only the app's MCP server", () => {
    const { argv } = scratchLaunchFragment({ mcpUrl: URL });
    expect(argv).toEqual([
      "--setting-sources",
      "user,project",
      "--mcp-config",
      JSON.stringify({ mcpServers: { equin: { type: "http", url: URL } } }),
      "--strict-mcp-config",
    ]);
  });

  test("the variadic --mcp-config is never the last flag", () => {
    const { argv } = scratchLaunchFragment({ mcpUrl: URL });
    expect(argv.at(-1)).toBe("--strict-mcp-config");
  });

  test("the profile's permissions ride the settings fragment", () => {
    const permissions = { allow: ["Bash", "Read"], deny: ["WebFetch"] };
    expect(
      scratchLaunchFragment({ mcpUrl: URL, permissions }).settings,
    ).toEqual({ permissions });
    expect(scratchLaunchFragment({ mcpUrl: URL }).settings).toEqual({});
  });
});
