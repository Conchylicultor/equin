import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  parseStructuredOutput,
  READ_ONLY_TOOLS,
  readOnlyOptions,
} from "./run-claude-read-only";

describe("readOnlyOptions", () => {
  const options = readOnlyOptions("/repo", z.object({ a: z.string() }), "sys");

  test("hands the CLI a draft-07 schema, the only dialect it validates", () => {
    expect(options.outputFormat).toMatchObject({
      type: "json_schema",
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        properties: { a: { type: "string" } },
      },
    });
  });

  test("offers only the read-only tools", () => {
    expect(options.tools).toEqual([...READ_ONLY_TOOLS]);
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  test("restricts, loads no settings or MCP server and denies anything that would prompt", () => {
    expect(options.extraArgs).toEqual({ restricted: null });
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.cwd).toBe("/repo");
  });

  test("never widens the tool set", () => {
    expect(options.allowedTools).toBeUndefined();
    expect(options.additionalDirectories).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
  });
});

describe("parseStructuredOutput", () => {
  const schema = z.object({ n: z.number() });

  test("reads an answer inside the schema", () => {
    expect(parseStructuredOutput({ n: 1 }, schema)).toEqual({ n: 1 });
  });

  test("throws on an answer outside the schema", () => {
    expect(() => parseStructuredOutput({ n: "x" }, schema)).toThrow(
      /outside its schema/,
    );
  });

  test("throws when the turn ended without a structured answer", () => {
    expect(() => parseStructuredOutput(undefined, schema)).toThrow(
      /without a structured answer/,
    );
  });
});
