import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { headsLacking, LAYOUT_RULE_MODULES } from "./checkouts";

describe("the stale-checkout probe", () => {
  test("probes a module this checkout really has (a move must update it)", () => {
    expect(existsSync(join(REPO_ROOT, LAYOUT_RULE_MODULES[0]))).toBe(true);
  });

  test("a head missing the rule at every path lacks it; a blob at any path has it", () => {
    const [now, before] = LAYOUT_RULE_MODULES;
    const out = [
      `aaa:${now} missing`,
      `aaa:${before} missing`,
      `bbb:${now} missing`,
      "bbb111 blob 42",
      "ccc111 blob 42",
      `ccc:${before} missing`,
    ].join("\n");
    expect([...headsLacking(["aaa", "bbb", "ccc"], out)]).toEqual(["aaa"]);
  });

  test("any other answer throws instead of counting either way", () => {
    expect(() => headsLacking(["aaa"], "aaa tree 12\naaa missing\n")).toThrow();
    expect(() => headsLacking(["aaa", "bbb"], "aaa missing\n")).toThrow();
  });
});
