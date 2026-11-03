import { describe, expect, test } from "bun:test";
import { createInlineAudit } from "./inline-audit";

const ROOTS = ["/repo/plugins/x/prewarm", "/repo/plugins/x/shared"];
// What the address hashed: the snapshot's files in those roots.
const HASHED = [
  "/repo/plugins/x/prewarm/index.ts",
  "/repo/plugins/x/prewarm/internal/cases.tsx",
  "/repo/plugins/x/prewarm/a.css",
  "/repo/plugins/x/shared/util.ts",
];

/**
 * Drive the REAL `generateBundle` hook with a synthetic bundle, so the test
 * exercises the shape rollup actually hands the plugin rather than a private
 * setter. The double cast is the narrowest way to call the hook off the vite
 * `Plugin` type (whose hooks are `ObjectHook` unions) with a bundle stub that
 * carries only the fields the hook reads.
 */
function auditOf(moduleIds: string[]) {
  const audit = createInlineAudit({
    dirName: "x.prewarm.abc123",
    hashedRoots: ROOTS,
    hashedFiles: HASHED,
    kind: "prewarm",
  });
  const bundle = {
    "index.js": {
      type: "chunk",
      modules: Object.fromEntries(moduleIds.map((id) => [id, {}])),
    },
    "index.js.map": { type: "asset" }, // assets carry no modules — must be skipped
  };
  const hook = audit.plugin.generateBundle as unknown as (
    options: unknown,
    bundle: unknown,
  ) => void;
  hook(null, bundle);
  return audit;
}

describe("createInlineAudit", () => {
  test("passes when every first-party module is a hashed file", () => {
    expect(() =>
      auditOf([
        "/repo/plugins/x/prewarm/index.ts",
        "/repo/plugins/x/prewarm/internal/cases.tsx",
        "/repo/plugins/x/shared/util.ts",
      ]).verify(),
    ).not.toThrow();
  });

  test("skips virtual ids, node_modules, and non-path ids", () => {
    expect(() =>
      auditOf([
        "\0commonjsHelpers.js",
        "\0vite/preload-helper",
        "/repo/node_modules/some-pkg/dist/index.mjs",
        "/repo/plugins/x/node_modules/some-dep/index.js",
        "virtual:some-plugin",
        "/repo/plugins/x/prewarm/index.ts",
      ]).verify(),
    ).not.toThrow();
  });

  test("query suffixes are stripped before the containment check", () => {
    expect(() =>
      auditOf(["/repo/plugins/x/prewarm/a.css?used"]).verify(),
    ).not.toThrow();
    expect(() => auditOf(["/repo/plugins/x/web/a.css?used"]).verify()).toThrow(
      "/repo/plugins/x/web/a.css",
    );
  });

  test("test code inside a hashed root is not hashed, so inlining it throws", () => {
    for (const id of [
      "/repo/plugins/x/prewarm/testing/index.ts",
      "/repo/plugins/x/prewarm/__tests__/helper.tsx",
      "/repo/plugins/x/shared/util.test.ts",
    ]) {
      expect(() =>
        auditOf(["/repo/plugins/x/prewarm/index.ts", id]).verify(),
      ).toThrow(id);
    }
  });

  test("a file inside a root the snapshot does not hold (gitignored, or written after it) throws", () => {
    const id = "/repo/plugins/x/prewarm/registry.generated.ts";
    expect(() =>
      auditOf(["/repo/plugins/x/prewarm/index.ts", id]).verify(),
    ).toThrow(id);
  });

  test("throws naming the artifact and the offending file", () => {
    let message = "";
    try {
      auditOf([
        "/repo/plugins/x/prewarm/index.ts",
        "/repo/plugins/x/web/internal/bar.tsx",
      ]).verify();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("x.prewarm.abc123");
    expect(message).toContain("/repo/plugins/x/web/internal/bar.tsx");
    expect(message).not.toContain("/repo/plugins/x/prewarm/index.ts");
    expect(message).toContain("inlinedRootsFor()");
  });

  test("a sibling dir sharing a root's prefix is NOT inside it", () => {
    expect(() =>
      auditOf(["/repo/plugins/x/prewarm-extra/a.ts"]).verify(),
    ).toThrow("/repo/plugins/x/prewarm-extra/a.ts");
  });

  test("caps the listed paths and summarizes the rest", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `/repo/plugins/x/web/f${i}.ts`,
    );
    expect(() => auditOf(many).verify()).toThrow("…and 5 more");
  });
});
