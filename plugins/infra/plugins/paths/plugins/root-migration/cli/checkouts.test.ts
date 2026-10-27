import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { headsLacking, LAYOUT_RULE_MODULE } from "./checkouts";

describe("the stale-checkout probe", () => {
  test("probes a module this checkout really has (a move must update it)", () => {
    expect(existsSync(join(REPO_ROOT, LAYOUT_RULE_MODULE))).toBe(true);
  });

  test("a head answered `missing` lacks the layout rule; a blob has it", () => {
    const out = `aaa:${LAYOUT_RULE_MODULE} missing\nbbb111 blob 42\n`;
    expect([...headsLacking(["aaa", "bbb"], out)]).toEqual(["aaa"]);
  });

  test("any other answer throws instead of counting either way", () => {
    expect(() => headsLacking(["aaa"], "aaa tree 12\n")).toThrow();
    expect(() => headsLacking(["aaa", "bbb"], "aaa missing\n")).toThrow();
  });
});
