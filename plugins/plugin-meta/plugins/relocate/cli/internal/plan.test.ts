import { describe, expect, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  scanReorderItemRefs,
  type PluginRef,
} from "@plugins/plugin-meta/plugins/plugin-refs/core";
import {
  scanCssRefs,
  scanMarkdownRefs,
  scanPathRefs,
} from "@plugins/plugin-meta/plugins/plugin-refs/core/testing";
import {
  applyEdits,
  mapRepoPath,
  parsePluginArg,
  planMove,
  type Move,
  type MovePlanInput,
} from "./plan";

/**
 * A fixture path under `plugins/`. Spelled through a template so the fixtures
 * (fictional plugins) are data, not plugin references: plugin-refs reads a
 * whole `"plugins/…"` literal as one, in test code too, and would both fail
 * `plugin-refs-resolve` on them and let a real move rewrite them.
 */
const P = (rest: string) => `plugins/${rest}`;

const move = (from: string, to: string): Move => ({
  from: parsePluginArg(from),
  to: parsePluginArg(to),
});

/** Plan over in-memory files: scans them with the real scanners. */
function plan(
  m: Move,
  files: Record<string, string>,
  extra: Partial<MovePlanInput> = {},
) {
  const refs: PluginRef[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith(".ts")) refs.push(...scanPathRefs(file, text));
    else if (file.endsWith(".md")) refs.push(...scanMarkdownRefs(file, text));
    else if (file.endsWith(".css")) refs.push(...scanCssRefs(file, text));
    else if (file.endsWith(".jsonc"))
      refs.push(...scanReorderItemRefs(file, text));
  }
  return planMove({
    move: m,
    movedIds: [m.from.id],
    compositionRoots: new Set(),
    hasConfigDir: false,
    refs,
    read: (f) => files[f] ?? null,
    ...extra,
  });
}

const textOf = (p: ReturnType<typeof plan>, file: string) =>
  p.rewrites.find((r) => r.file === file)?.text;

describe("parsePluginArg", () => {
  test("path and dot id are the same location", () => {
    const a = parsePluginArg(P("kit/plugins/overlay/plugins/hint/"));
    const b = parsePluginArg("kit.overlay.hint");
    expect(a).toEqual(b);
    expect(a).toEqual({
      id: asPluginId("kit.overlay.hint"),
      dir: P("kit/plugins/overlay/plugins/hint"),
      configDir: "config/kit/overlay/hint",
    });
  });

  test("rejects a folder inside a plugin", () => {
    expect(() => parsePluginArg(P("a/web"))).toThrow(/not a plugin path/);
    expect(() => parsePluginArg(P("a/web/b"))).toThrow(/plugins\/" folder/);
    expect(() => parsePluginArg("a..b")).toThrow(/bad segment/);
  });
});

describe("mapRepoPath", () => {
  const m = move("a.b", "c");
  test("re-roots the plugin dir and config dir, leaves siblings", () => {
    expect(mapRepoPath(m, P("a/plugins/b/web/x.ts"))).toBe(P("c/web/x.ts"));
    expect(mapRepoPath(m, "config/a/b/x.jsonc")).toBe("config/c/x.jsonc");
    expect(mapRepoPath(m, P("a/plugins/bb/web/x.ts"))).toBe(
      P("a/plugins/bb/web/x.ts"),
    );
  });
});

describe("path refs", () => {
  test("rewrites specifiers and literals, keeps the suffix, skips siblings", () => {
    const src = [
      `import { T } from "@plugins/kit/plugins/overlay/plugins/hint/web";`,
      `import { P } from "@plugins/kit/plugins/overlay/plugins/popover/web";`,
      `const d = "plugins/kit/plugins/overlay/plugins/hint/web/x.tsx";`,
      `const g = "plugins/kit/plugins/overlay/plugins/hint/**";`,
    ].join("\n");
    const p = plan(move("kit.overlay.hint", "kit.hint"), {
      [P("x/web/a.ts")]: src,
    });
    expect(textOf(p, P("x/web/a.ts"))).toBe(
      [
        `import { T } from "@plugins/kit/plugins/hint/web";`,
        `import { P } from "@plugins/kit/plugins/overlay/plugins/popover/web";`,
        `const d = "plugins/kit/plugins/hint/web/x.tsx";`,
        `const g = "plugins/kit/plugins/hint/**";`,
      ].join("\n"),
    );
    expect(p.counts.get("path:specifier")).toBe(1);
    expect(p.counts.get("path:literal")).toBe(2);
  });

  test("a nested move rewrites parent and child refs, each exactly once", () => {
    const src = [
      `import "@plugins/a/web";`,
      `import "@plugins/a/plugins/b/web";`,
      `import "@plugins/a/plugins/b/plugins/c/core";`,
    ].join("\n");
    const p = plan(
      move("a", "z.a"),
      { [P("q/web/i.ts")]: src },
      { movedIds: ["a", "a.b", "a.b.c"].map(asPluginId) },
    );
    expect(textOf(p, P("q/web/i.ts"))).toBe(
      [
        `import "@plugins/z/plugins/a/web";`,
        `import "@plugins/z/plugins/a/plugins/b/web";`,
        `import "@plugins/z/plugins/a/plugins/b/plugins/c/core";`,
      ].join("\n"),
    );
    expect(p.plugins.map((x) => x.to)).toEqual(
      ["z.a", "z.a.b", "z.a.b.c"].map(asPluginId),
    );
  });

  test("a rename-only move (same parent, new basename)", () => {
    const p = plan(move("a.old", "a.new"), {
      [P("q/core/i.ts")]:
        `import "@plugins/a/plugins/old/core";\nimport "@plugins/a/plugins/older/core";`,
    });
    expect(textOf(p, P("q/core/i.ts"))).toBe(
      `import "@plugins/a/plugins/new/core";\nimport "@plugins/a/plugins/older/core";`,
    );
  });

  test("generated files are never edited", () => {
    const p = plan(move("a", "b"), {
      [P("q/core/x.generated.ts")]: `import "@plugins/a/web";`,
    });
    expect(p.rewrites).toEqual([]);
  });
});

describe("dot refs", () => {
  test("reorder item keys swap the id prefix, not a sibling that shares it", () => {
    const text = `{ "items": ["a.b:x", "a.bb:y", "a.b.c:z"] }`;
    const p = plan(move("a.b", "d"), { "config/shell/reorder.jsonc": text });
    expect(textOf(p, "config/shell/reorder.jsonc")).toBe(
      `{ "items": ["d:x", "a.bb:y", "d.c:z"] }`,
    );
    expect(p.counts.get("dot:reorder-items")).toBe(2);
  });
});

describe("relative refs", () => {
  test("a link INTO the moved plugin re-points at its new place", () => {
    const md =
      "See [tip](plugins/kit/plugins/overlay/plugins/hint/CLAUDE.md#x).";
    const p = plan(move("kit.overlay.hint", "kit.hint"), {
      "README.md": md,
    });
    expect(textOf(p, "README.md")).toBe(
      "See [tip](plugins/kit/plugins/hint/CLAUDE.md#x).",
    );
  });

  test("a link FROM the moved plugin re-relativizes across a depth change", () => {
    const file = P("kit/plugins/overlay/plugins/hint/CLAUDE.md");
    const md = [
      "[plan](../../../../../../research/x.md)",
      "[sibling](../popover/CLAUDE.md)",
      "[self](./web/index.ts)",
      "[dir](../../plugins/)",
    ].join("\n");
    const p = plan(move("kit.overlay.hint", "kit.hint"), {
      [file]: md,
    });
    const r = p.rewrites.find((x) => x.file === file)!;
    expect(r.newFile).toBe(P("kit/plugins/hint/CLAUDE.md"));
    expect(r.text).toBe(
      [
        "[plan](../../../../research/x.md)",
        "[sibling](../overlay/plugins/popover/CLAUDE.md)",
        "[self](./web/index.ts)",
        "[dir](../overlay/plugins/)",
      ].join("\n"),
    );
  });

  test("a link inside the moved subtree to itself is untouched", () => {
    const file = P("a/plugins/b/CLAUDE.md");
    const p = plan(move("a.b", "c.d.b"), {
      [file]: "[x](plugins/c/CLAUDE.md)",
    });
    expect(p.rewrites).toEqual([]);
  });

  test("a CSS @source glob keeps working, and stays ./-relative", () => {
    const file = P("a/plugins/b/web/styles.css");
    const css = [
      `@source "../../../../x/**/*.tsx";`,
      `@source "./**/*.tsx";`,
      `@import "../../../../shared.css";`,
    ].join("\n");
    const p = plan(move("a.b", "b"), { [file]: css });
    const r = p.rewrites.find((x) => x.file === file)!;
    expect(r.newFile).toBe(P("b/web/styles.css"));
    expect(r.text).toBe(
      [
        `@source "../../x/**/*.tsx";`,
        `@source "./**/*.tsx";`,
        `@import "../../shared.css";`,
      ].join("\n"),
    );
  });

  test("an @source glob pointing into the moved plugin moves with it", () => {
    const css = `@source "../../plugins/a/plugins/b/web/**/*.tsx";`;
    const p = plan(move("a.b", "c"), { "web/src/app.css": css });
    expect(textOf(p, "web/src/app.css")).toBe(
      `@source "../../plugins/c/web/**/*.tsx";`,
    );
    expect(p.narrowedGlobs).toEqual([]);
  });

  test("a glob that covered the old location but not the new one is flagged", () => {
    const css = `@source "../../plugins/a/**/*.tsx";`;
    const p = plan(move("a.b", "c"), { "web/src/app.css": css });
    expect(p.rewrites).toEqual([]);
    expect(p.narrowedGlobs.map((g) => g.target)).toEqual([P("a/**/*.tsx")]);
  });

  test("research prose is never rewritten, research links are", () => {
    const md = "[x](../plugins/a/plugins/b/CLAUDE.md) plugins/a/plugins/b";
    const p = plan(move("a.b", "c"), { "research/r.md": md });
    expect(textOf(p, "research/r.md")).toBe(
      "[x](../plugins/c/CLAUDE.md) plugins/a/plugins/b",
    );
  });
});

describe("package names", () => {
  test("every moved plugin's name is re-derived; composition roots keep theirs", () => {
    const pkg = (name: string) =>
      `{\n  "name": "${name}",\n  "private": true\n}\n`;
    const p = plan(
      move("a", "z.a"),
      {
        [P("a/package.json")]: pkg("@equin/plugin-a"),
        [P("a/plugins/b/package.json")]: pkg("@equin/plugin-a-b"),
        [P("a/plugins/r/package.json")]: pkg("root-name"),
      },
      {
        movedIds: ["a", "a.b", "a.r"].map(asPluginId),
        compositionRoots: new Set([asPluginId("a.r")]),
      },
    );
    expect(p.packages.map((x) => [x.newFile, x.to])).toEqual([
      [P("z/plugins/a/package.json"), "@equin/plugin-z-a"],
      [P("z/plugins/a/plugins/b/package.json"), "@equin/plugin-z-a-b"],
    ]);
    expect(p.packages[0]!.text).toBe(pkg("@equin/plugin-z-a"));
  });
});

describe("applyEdits", () => {
  test("refuses a range that no longer holds its value", () => {
    const [ref] = scanPathRefs("f.ts", `import "@plugins/a/web";`);
    expect(() =>
      applyEdits("f.ts", `import "@plugins/b/web";`, [
        { ref: ref!, replacement: P("c") },
      ]),
    ).toThrow(/changed since it was scanned/);
  });

  test("refuses overlapping edits", () => {
    const [ref] = scanPathRefs("f.ts", `import "@plugins/a/web";`);
    expect(() =>
      applyEdits("f.ts", `import "@plugins/a/web";`, [
        { ref: ref!, replacement: P("c") },
        { ref: ref!, replacement: P("d") },
      ]),
    ).toThrow(/overlap/);
  });
});
