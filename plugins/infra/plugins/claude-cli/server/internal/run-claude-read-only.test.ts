import { describe, expect, test } from "bun:test";
import * as z4 from "zod/v4";
import {
  parseStructuredResult,
  READ_ONLY_TOOLS,
  readOnlyArgs,
} from "./run-claude-read-only";

describe("readOnlyArgs", () => {
  const args = readOnlyArgs("sonnet", "{}", "sys");
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  test("offers only the read-only tools", () => {
    expect(after("--tools")).toBe(READ_ONLY_TOOLS.join(","));
    expect(READ_ONLY_TOOLS).toEqual(["Read", "Grep", "Glob"]);
  });

  test("restricts, loads no MCP server and denies anything that would prompt", () => {
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(after("--permission-mode")).toBe("dontAsk");
  });

  test("never widens the tool set", () => {
    for (const flag of [
      "--allowedTools",
      "--allowed-tools",
      "--add-dir",
      "--dangerously-skip-permissions",
    ]) {
      expect(args).not.toContain(flag);
    }
  });
});

describe("parseStructuredResult", () => {
  const schema = z4.object({ n: z4.number() });
  const record = (extra: object) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      ...extra,
    });

  test("reads the structured answer of a single result record", () => {
    expect(
      parseStructuredResult(record({ structured_output: { n: 1 } }), schema),
    ).toEqual({ n: 1 });
  });

  test("reads the last record of a message-stream array", () => {
    const stream = `[{"type":"system"},${record({ structured_output: { n: 2 } })}]`;
    expect(parseStructuredResult(stream, schema)).toEqual({ n: 2 });
  });

  test("throws on an answer outside the schema", () => {
    expect(() =>
      parseStructuredResult(record({ structured_output: { n: "x" } }), schema),
    ).toThrow(/outside its schema/);
  });

  test("throws on an error result", () => {
    expect(() =>
      parseStructuredResult(
        record({ is_error: true, subtype: "error_max_turns" }),
        schema,
      ),
    ).toThrow(/error_max_turns/);
  });

  test("throws on non-JSON output", () => {
    expect(() => parseStructuredResult("oops", schema)).toThrow(/no JSON/);
  });
});
