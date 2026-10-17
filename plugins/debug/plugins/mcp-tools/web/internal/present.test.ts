import { describe, expect, test } from "bun:test";
import type { McpCatalogTool } from "@plugins/infra/plugins/mcp/core";
import { schemaTypeWords, toolParams, toolVisibility } from "./present";

function tool(over: Partial<McpCatalogTool>): McpCatalogTool {
  return {
    name: "t",
    declaredIn: null,
    description: "",
    hasLiveDescription: false,
    gated: false,
    profiles: null,
    inputSchema: { type: "object", properties: {} },
    ...over,
  };
}

describe("schemaTypeWords", () => {
  test("spells enums, unions and arrays", () => {
    expect(schemaTypeWords({ type: "string", enum: ["a", "b"] })).toBe(
      '"a" | "b"',
    );
    expect(
      schemaTypeWords({ anyOf: [{ type: "string" }, { type: "number" }] }),
    ).toBe("string | number");
    expect(schemaTypeWords({ type: "array", items: { type: "string" } })).toBe(
      "string[]",
    );
    expect(schemaTypeWords({})).toBe("any");
  });
});

describe("toolParams", () => {
  test("reads properties in order with required and description", () => {
    const params = toolParams(
      tool({
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "The query" },
            database: { type: "string" },
          },
          required: ["sql"],
        },
      }),
    );
    expect(params).toEqual([
      { name: "sql", type: "string", required: true, description: "The query" },
      { name: "database", type: "string", required: false, description: null },
    ]);
  });
});

describe("toolVisibility", () => {
  test("a profile reservation wins over a gate", () => {
    expect(toolVisibility(tool({ gated: true, profiles: ["p"] }))).toBe(
      "profile",
    );
    expect(toolVisibility(tool({ gated: true }))).toBe("gated");
    expect(toolVisibility(tool({}))).toBe("everywhere");
  });
});
