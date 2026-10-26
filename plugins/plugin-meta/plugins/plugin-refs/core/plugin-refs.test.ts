import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoFilesOver } from "@plugins/framework/plugins/tooling/core";
import {
  scanCompositionManifestRefs,
  scanReorderItemRefs,
} from "./config-refs";
import {
  BOUNDARY_CONFIG,
  COMPOSITIONS_MANIFEST,
  COMPOSITIONS_SOURCE,
  findPluginRefs,
} from "./find";
import { maskMarkdown, scanCssRefs, scanMarkdownRefs } from "./relative-refs";
import {
  pluginDirOfPath,
  relativeLinkFrom,
  resolveRelativeRef,
} from "./resolve";
import {
  scanAsPluginIdRefs,
  scanCompositionSourceRefs,
  scanPathRefs,
  scanRuntimeExceptionRefs,
} from "./ts-refs";
import type { PluginRef, RelativeRef } from "./types";

/** Every ref's range holds its value — the invariant a rewriter relies on. */
function expectRanges(text: string, refs: PluginRef[]): void {
  for (const r of refs)
    expect(text.slice(r.range.start, r.range.end)).toBe(r.value);
}

describe("path refs", () => {
  const src = [
    `import { a } from "@plugins/tasks/plugins/task-list/web";`,
    `const lazy = () => import("@plugins/apps/plugins/home/web");`,
    `mock.module("@plugins/infra/plugins/jobs/server", () => ({}));`,
    `const dir = "plugins/primitives/plugins/css/plugins/row/web/x.tsx";`,
    `const glob = 'plugins/debug/**';`,
    `// "plugins/in/a/comment" is not a ref`,
    `const fixture = "@plugins/fake/web"; // a string, not a specifier`,
    `const prose = "see plugins/foo for details";`,
    'const sample = `import { x } from "@plugins/inside/template/web"`;',
  ].join("\n");
  const refs = scanPathRefs("plugins/tasks/core/a.ts", src);

  test("finds literals and specifiers, spanning only the plugin dir", () => {
    expect(refs.map((r) => [r.syntax, r.value, r.line])).toEqual([
      ["specifier", "plugins/tasks/plugins/task-list", 1],
      ["specifier", "plugins/apps/plugins/home", 2],
      ["specifier", "plugins/infra/plugins/jobs", 3],
      ["literal", "plugins/primitives/plugins/css/plugins/row", 4],
      ["literal", "plugins/debug", 5],
    ]);
    expectRanges(src, refs);
  });

  test("a specifier's range starts after the @", () => {
    expect(src[refs[0]!.range.start - 1]).toBe("@");
  });
});

describe("dot refs", () => {
  test("asPluginId: fixed string arguments only, empty root skipped", () => {
    const src = [
      `const A = asPluginId("plugin-meta.composition");`,
      `const B = asPluginId(x);`,
      `const C = asPluginId("");`,
      `// asPluginId("in.comment")`,
    ].join("\n");
    const refs = scanAsPluginIdRefs("plugins/tasks/core/a.ts", src);
    expect(refs.map((r) => String(r.id))).toEqual(["plugin-meta.composition"]);
    expectRanges(src, refs);
  });

  test("runtimeExceptions: both sides, id only", () => {
    const src = [
      `export default defineBoundaries({`,
      `  folders: { core: ["core"] },`,
      `  runtimeExceptions: [`,
      `    // "plugin.not.this.core -> plugin.nor.this.core"`,
      `    "plugin.infra.secrets.central -> plugin.infra.paths.server",`,
      `    "plugin.database.core -> plugin.database.data-dirs",`,
      `  ],`,
      `  exclude: ["plugin.not.an.exception.core"],`,
      `});`,
    ].join("\n");
    const refs = scanRuntimeExceptionRefs(BOUNDARY_CONFIG, src);
    expect(refs.map((r) => String(r.id))).toEqual([
      "infra.secrets",
      "infra.paths",
      "database",
      "database",
    ]);
    expectRanges(src, refs);
  });

  test("runtimeExceptions: a malformed side throws", () => {
    const src = `x({ runtimeExceptions: ["zone.a.core -> plugin.b.core"] })`;
    expect(() => scanRuntimeExceptionRefs(BOUNDARY_CONFIG, src)).toThrow(
      /is not "plugin\./,
    );
  });

  test("compositions source: entryPoints / selectedContributors array literals only", () => {
    const src = [
      `const SHARED = { entryPoints: ["apps.x.**", "!apps.x.y.**"] };`,
      `const rows = [`,
      `  { id: "all", entryPoints: ["**"], selectedContributors: [] as string[] },`,
      `  { ...SHARED, selectedContributors: ["ui.toggle" /* "not.a.ref" */], extends: ["pack"] },`,
      `  pack("p", { selectedContributors: [\n    "wish.element-picker",\n    'review',\n  ] }),`,
      `];`,
      `const label = "apps.not-a-ref";`,
    ].join("\n");
    const refs = scanCompositionSourceRefs(COMPOSITIONS_SOURCE, src);
    expect(refs.map((r) => String(r.id))).toEqual([
      "apps.x",
      "apps.x.y",
      "ui.toggle",
      "wish.element-picker",
      "review",
    ]);
    expect(new Set(refs.map((r) => r.site))).toEqual(
      new Set(["composition-source"]),
    );
    expectRanges(src, refs);
  });

  test("compositions manifest: entryPoints + selectedContributors, not extends/excludes", () => {
    const text = `// @hash x
{
  "manifests": [
    {
      "id": "m",
      "entryPoints": ["**", "apps.home.**", "!review.plugin-changes.**", "search"],
      "selectedContributors": ["ui.theme-toggle"],
      "extends": ["served-baseline"],
      "excludes": ["auth"],
    },
  ],
}`;
    const refs = scanCompositionManifestRefs(COMPOSITIONS_MANIFEST, text);
    expect(refs.map((r) => String(r.id))).toEqual([
      "apps.home",
      "review.plugin-changes",
      "search",
      "ui.theme-toggle",
    ]);
    expectRanges(text, refs);
  });

  test("compositions manifest without a manifests array throws", () => {
    expect(() =>
      scanCompositionManifestRefs(COMPOSITIONS_MANIFEST, `{}`),
    ).toThrow(/manifests/);
  });

  test("reorder items: the plugin-id half of entry keys, at any depth", () => {
    const text = `{
  "slots": {
    "shell.toolbar": {
      "items": ["apps.home:open", { "group": "g", "items": ["tasks.task-list:new"] }, "spacer"],
    },
  },
  "other": ["not.items:key"],
}`;
    const refs = scanReorderItemRefs("config/x/reorder.origin.jsonc", text);
    expect(refs.map((r) => String(r.id))).toEqual([
      "apps.home",
      "tasks.task-list",
    ]);
    expectRanges(text, refs);
  });
});

describe("relative refs", () => {
  test("markdown: links, definitions, html; skips urls, anchors, code", () => {
    const src = [
      'See [a](../a/CLAUDE.md#section) and ![img](./pic.png "title").',
      "[def]: ../../research/doc.md",
      '<img src="shot.png" width="40">',
      "[web](https://example.com) [mail](mailto:x@y.z) [anchor](#top) [abs](/etc/x)",
      "`[code](not/a/link.md)`",
      "```",
      "[fenced](not/either.md)",
      "```",
      "<!-- [commented](nope.md) -->",
      "[spaced](<dir with space/x.md>)",
    ].join("\n");
    const refs = scanMarkdownRefs("plugins/tasks/CLAUDE.md", src);
    expect(refs.map((r) => [r.syntax, r.value])).toEqual([
      ["md-link", "../a/CLAUDE.md"],
      ["md-link", "./pic.png"],
      ["md-link", "dir with space/x.md"],
      ["md-definition", "../../research/doc.md"],
      ["html-attr", "shot.png"],
    ]);
    expectRanges(src, refs);
  });

  test("maskMarkdown keeps length and newlines", () => {
    const src = "a `b` c\n```\nx\n```\nd";
    const masked = maskMarkdown(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split("\n").length).toBe(src.split("\n").length);
    expect(masked).not.toContain("`b`");
  });

  test("css: relative @source/@import only, globs flagged", () => {
    const src = [
      `@import "tailwindcss" source(none);`,
      `@import "./theme.css";`,
      `/* @source "../../commented/"; */`,
      `@source "../../../plugins/";`,
      `@source not "../**/*.test.tsx";`,
    ].join("\n");
    const refs = scanCssRefs("web/app.css", src);
    expect(refs.map((r) => [r.syntax, r.value, r.glob])).toEqual([
      ["css-import", "./theme.css", false],
      ["css-source", "../../../plugins/", false],
      ["css-source", "../**/*.test.tsx", true],
    ]);
    expectRanges(src, refs);
  });

  const rel = (file: string, value: string, glob = false): RelativeRef => ({
    kind: "relative",
    syntax: "md-link",
    file,
    range: { start: 0, end: value.length },
    line: 1,
    value,
    glob,
  });

  test("resolveRelativeRef: inside, outside, glob static prefix, percent-decoding", () => {
    expect(
      resolveRelativeRef(rel("plugins/tasks/CLAUDE.md", "../../research/x.md")),
    ).toEqual({
      kind: "inside",
      target: "research/x.md",
      staticPath: "research/x.md",
    });
    expect(resolveRelativeRef(rel("docs/x.md", "../../out.md")).kind).toBe(
      "outside",
    );
    expect(
      resolveRelativeRef(rel("a/b/app.css", "../plugins/**/*.tsx", true)),
    ).toEqual({
      kind: "inside",
      target: "a/plugins/**/*.tsx",
      staticPath: "a/plugins",
    });
    expect(resolveRelativeRef(rel("d/x.md", "my%20file.md"))).toMatchObject({
      target: "d/my file.md",
    });
  });

  test("relativeLinkFrom inverts resolveRelativeRef across a depth change", () => {
    const from = "plugins/tasks/plugins/task-list/CLAUDE.md";
    const target = "research/doc.md";
    const link = relativeLinkFrom(from, target);
    expect(link).toBe("../../../../research/doc.md");
    expect(resolveRelativeRef(rel(from, link))).toMatchObject({ target });
    expect(relativeLinkFrom("docs/a.md", "docs/b.md")).toBe("b.md");
  });

  test("pluginDirOfPath follows the plugins/ grammar", () => {
    expect(pluginDirOfPath("plugins/tasks/plugins/task-list/web/x.ts")).toBe(
      "plugins/tasks/plugins/task-list",
    );
    expect(pluginDirOfPath("docs/x.md")).toBeNull();
  });
});

describe("findPluginRefs over a fixture repo", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-refs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const files: Record<string, string> = {
    [COMPOSITIONS_MANIFEST]: `{ "manifests": [{ "entryPoints": ["apps.home.**"], "selectedContributors": [] }] }`,
    [COMPOSITIONS_SOURCE]: `pack("p", { selectedContributors: ["apps.home"] });`,
    [BOUNDARY_CONFIG]: `export default { runtimeExceptions: ["plugin.a.core -> plugin.a.data-dirs"] };`,
    "config/shell/reorder.origin.jsonc": `{ "items": ["tasks.task-list:new"] }`,
    "plugins/tasks/core/x.ts": `import { y } from "@plugins/b/core";\nconst id = asPluginId("a.b");`,
    "plugins/tasks/core/x.test.ts": `const id = asPluginId("fixture.only");\nconst p = "plugins/c";`,
    "plugins/tasks/core/reg.generated.ts": `import x from "@plugins/gen/web";`,
    "plugins/tasks/CLAUDE.md": `[doc](../../research/r.md)`,
    "research/r.md": `[gone](nowhere.md)`,
    "web/app.css": `@source "../plugins/";`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const repo = repoFilesOver(root, Object.keys(files).sort());

  test("collects every kind, skipping generated files and test-code asPluginId", async () => {
    const refs = await findPluginRefs(repo);
    const summary = refs.map((r) => `${r.file} ${r.kind} ${r.value}`);
    expect(summary).toEqual([
      "config/plugin-meta/composition/compositions.origin.jsonc dot apps.home",
      "config/shell/reorder.origin.jsonc dot tasks.task-list",
      "plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts dot a",
      "plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts dot a",
      "plugins/plugin-meta/plugins/composition/core/config.ts dot apps.home",
      "plugins/tasks/CLAUDE.md relative ../../research/r.md",
      "plugins/tasks/core/x.test.ts path plugins/c",
      "plugins/tasks/core/x.ts path plugins/b",
      "plugins/tasks/core/x.ts dot a.b",
      "research/r.md relative nowhere.md",
      "web/app.css relative ../plugins/",
    ]);
  });

  test("kinds narrows the scan", async () => {
    const refs = await findPluginRefs(repo, { kinds: ["relative"] });
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set(["relative"]));
  });

  test("a missing fixed input throws rather than reporting no refs", async () => {
    const partial = repoFilesOver(root, ["plugins/tasks/core/x.ts"]);
    const outcome = await findPluginRefs(partial, { kinds: ["dot"] }).then(
      () => "resolved",
      (err: unknown) => String(err),
    );
    expect(outcome).toMatch(/missing/);
  });
});
