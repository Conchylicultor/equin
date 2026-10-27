import { describe, expect, it } from "bun:test";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import {
  FILE_CATEGORY_GLOBS,
  globToRegExp,
  isInAnyCategory,
  isInCategory,
} from "./file-category";
import { ruleIdProblems } from "./load";
import { createExemptionIndex } from "./matcher";
import { covers, manifestPathError, resolveManifest } from "./resolve";

/** A real plugin, so the fixture paths resolve for plugin-refs-resolve. */
const P = "primitives/plugins/networking";

function throwsMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}

describe("manifest paths", () => {
  it("accepts a file, a directory and the whole plugin", () => {
    expect(manifestPathError("server/internal/x.ts")).toBeNull();
    expect(manifestPathError("web")).toBeNull();
    expect(manifestPathError(".")).toBeNull();
  });

  it("refuses escaping, absolute, glob and non-canonical paths", () => {
    expect(manifestPathError("../other/x.ts")).toContain("escapes");
    expect(manifestPathError("web/../../x.ts")).toContain("escapes");
    expect(manifestPathError("/abs/x.ts")).toContain("absolute");
    expect(manifestPathError("web/**/*.ts")).toContain("glob");
    expect(manifestPathError("./web")).toContain("canonical");
    expect(manifestPathError("web/")).toContain("ends with /");
    expect(manifestPathError("a//b")).toContain("canonical");
    expect(manifestPathError("")).toContain("empty");
  });
});

describe("resolveManifest", () => {
  it("resolves every path relative to its plugin", () => {
    const out = resolveManifest("infra/plugins/jobs", [
      {
        rule: "timer/no-unlisted-timer",
        paths: ["server/a.ts", "."],
        kind: "sanctioned",
        reason: "why",
      },
    ]);
    expect(out.map((e) => e.target)).toEqual([
      "plugins/infra/plugins/jobs/server/a.ts",
      "plugins/infra/plugins/jobs",
    ]);
    expect(out[0]!.manifest).toBe("plugins/infra/plugins/jobs/exempt/index.ts");
  });

  it("requires a task on debt and a reason on both kinds", () => {
    const debt = resolveManifest(P, [
      {
        rule: "x/y",
        paths: ["a.ts"],
        kind: "debt",
        task: "task-1",
        reason: "r",
      },
    ]);
    expect(debt[0]).toMatchObject({ kind: "debt", task: "task-1" });
    expect(
      throwsMessage(() =>
        resolveManifest(P, [
          { rule: "x/y", paths: ["a.ts"], kind: "debt", reason: "r" },
        ]),
      ),
    ).toContain("plugins/primitives/plugins/networking/exempt/index.ts");
    expect(() =>
      resolveManifest(P, [
        { rule: "x/y", paths: ["a.ts"], kind: "sanctioned", reason: "  " },
      ]),
    ).toThrow("reason is required");
    // A sanctioned entry carrying a task is a mis-declared debt entry.
    expect(() =>
      resolveManifest(P, [
        {
          rule: "x/y",
          paths: ["a.ts"],
          kind: "sanctioned",
          task: "t",
          reason: "r",
        },
      ]),
    ).toThrow();
  });

  it("refuses an escaping path and a non-array export", () => {
    expect(() =>
      resolveManifest(P, [
        { rule: "x/y", paths: ["../q/a.ts"], kind: "sanctioned", reason: "r" },
      ]),
    ).toThrow("escapes the plugin");
    expect(() => resolveManifest(P, undefined)).toThrow(
      "invalid exemption manifest",
    );
  });
});

describe("matcher", () => {
  const entries = resolveManifest(P, [
    {
      rule: "x/y",
      paths: ["web/a.ts", "server"],
      kind: "sanctioned",
      reason: "r",
    },
    { rule: "x/z", paths: ["."], kind: "sanctioned", reason: "r" },
  ]);

  it("covers a file exactly and a directory by subtree, never a sibling prefix", () => {
    expect(
      covers(
        "plugins/primitives/plugins/networking/server",
        "plugins/primitives/plugins/networking/server/x.ts",
      ),
    ).toBe(true);
    expect(
      covers(
        "plugins/primitives/plugins/networking/server",
        "plugins/primitives/plugins/networking/server-two/x.ts",
      ),
    ).toBe(false);
    expect(
      covers(
        "plugins/primitives/plugins/networking/web/a.ts",
        "plugins/primitives/plugins/networking/web/a.ts",
      ),
    ).toBe(true);
  });

  it("matches per rule and records hits for unused detection", () => {
    const index = createExemptionIndex(entries);
    const xy = index.exemptionsFor("x/y");
    expect(
      xy.match("plugins/primitives/plugins/networking/web/a.ts")?.path,
    ).toBe("web/a.ts");
    expect(
      xy.match("plugins/primitives/plugins/networking/web/b.ts"),
    ).toBeUndefined();
    expect(
      index
        .exemptionsFor("x/q")
        .match("plugins/primitives/plugins/networking/web/a.ts"),
    ).toBeUndefined();
    expect(index.unused().map((e) => `${e.rule} ${e.path}`)).toEqual([
      "x/y server",
      "x/z .",
    ]);
    expect(
      index
        .at("plugins/primitives/plugins/networking/web/a.ts")
        .map((e) => e.rule),
    ).toEqual(["x/y"]);
  });

  it("returns the most specific cover", () => {
    const index = createExemptionIndex(
      resolveManifest(P, [
        {
          rule: "x/y",
          paths: [".", "web/a.ts"],
          kind: "sanctioned",
          reason: "r",
        },
      ]),
    );
    expect(
      index
        .exemptionsFor("x/y")
        .match("plugins/primitives/plugins/networking/web/a.ts")?.path,
    ).toBe("web/a.ts");
  });
});

describe("ruleIdProblems", () => {
  it("names unknown and closed rules", () => {
    const entries = resolveManifest(P, [
      { rule: "x/open", paths: ["a"], kind: "sanctioned", reason: "r" },
      { rule: "x/shut", paths: ["a"], kind: "sanctioned", reason: "r" },
      { rule: "x/typo", paths: ["a"], kind: "sanctioned", reason: "r" },
    ]);
    const problems = ruleIdProblems(entries, {
      known: new Set(["x/open", "x/shut"]),
      closed: new Set(["x/shut"]),
      noDebt: new Set(),
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("closed");
    expect(problems[1]).toContain("x/typo");
  });

  it("refuses a debt entry for a noDebt rule, and only a debt entry", () => {
    const entries = resolveManifest(P, [
      { rule: "x/strict", paths: ["a"], kind: "sanctioned", reason: "r" },
      { rule: "x/strict", paths: ["b"], kind: "debt", task: "t", reason: "r" },
      { rule: "x/open", paths: ["c"], kind: "debt", task: "t", reason: "r" },
    ]);
    const problems = ruleIdProblems(entries, {
      known: new Set(["x/open", "x/strict"]),
      closed: new Set(),
      noDebt: new Set(["x/strict"]),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"b"');
    expect(problems[0]).toContain("sanctioned-only");
  });
});

describe("file categories", () => {
  it("compiles the supported glob syntax and refuses the rest", () => {
    expect(globToRegExp("**/*.test.{ts,tsx}").test("a/b/c.test.tsx")).toBe(
      true,
    );
    expect(globToRegExp("**/e2e/**").test("e2e/x.ts")).toBe(true);
    expect(
      globToRegExp("**/e2e/**").test(
        "plugins/primitives/plugins/networking/e2e/x.ts",
      ),
    ).toBe(true);
    expect(
      globToRegExp("**/e2e/**").test(
        "plugins/primitives/plugins/networking/e2e-ish/x.ts",
      ),
    ).toBe(false);
    expect(
      globToRegExp("research/**").test(
        "plugins/primitives/plugins/networking/research/x.md",
      ),
    ).toBe(false);
    expect(() => globToRegExp("a/[ab].ts")).toThrow("unsupported");
  });

  it("agrees with isTestCodePath for test code inside a plugin", () => {
    for (const rel of [
      "web/__tests__/a.test.tsx",
      "core/testing/index.ts",
      "server/x.test.ts",
      "server/x.ts",
      "web/test-utils.ts",
    ]) {
      expect(
        isInCategory(`plugins/primitives/plugins/networking/${rel}`, "test"),
      ).toBe(isTestCodePath(rel.split("/")));
    }
  });

  it("matches each category's folder at any depth", () => {
    expect(
      isInCategory(
        "plugins/framework/plugins/cli/plugins/build/cli/x.ts",
        "cli",
      ),
    ).toBe(true);
    expect(isInCategory("research/2026-x.md", "research")).toBe(true);
    expect(
      isInAnyCategory("plugins/auth/server/x.ts", ["e2e", "central"]),
    ).toBe(false);
    expect(Object.keys(FILE_CATEGORY_GLOBS).length).toBe(9);
  });
});
