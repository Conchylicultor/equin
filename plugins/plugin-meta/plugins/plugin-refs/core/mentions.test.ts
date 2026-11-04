import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { repoFilesOver } from "@plugins/framework/plugins/tooling/core";
import { findPluginMentions } from "./mentions";

/**
 * A fixture path under `plugins/`, spelled through a template so the fictional
 * plugins are data: plugin-refs reads a whole `"plugins/…"` literal as a ref,
 * in test code too, and `plugin-refs-resolve` would fail on it.
 */
const P = (rest: string) => `plugins/${rest}`;

describe("findPluginMentions", () => {
  const root = asAppPath(mkdtempSync(join(tmpdir(), "plugin-mentions-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const files: Record<string, string> = {
    // A specifier held as data, a descendant's path, a test's id, prose.
    [P("x/core/vocab.ts")]: [
      `const CORE = "@plugins/db/plugins/feed/core";`,
      `// see plugins/db/plugins/feed/plugins/sub/CLAUDE.md`,
      `const id = asPluginId("db.feed.sub");`,
      `const other = "plugins/db/plugins/feed-two";`,
      `const nested = "plugins/y/plugins/db/plugins/feed";`,
      `const rel = "../plugins/db/plugins/feed";`,
      `const word = "xdb.feed";`,
    ].join("\n"),
    // A relative link is a relative ref, not a mention; its code span is one.
    [P("y/CLAUDE.md")]:
      "[child](plugins/db/plugins/feed/CLAUDE.md) and `plugins/db/plugins/feed`, `db.feed`.",
    [P("y/img.png")]: "\u0000plugins/db/plugins/feed",
    [P("y/top.ts")]: `const t = "plugins/solo/web"; // solo has no dot form`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const repo = repoFilesOver(root, Object.keys(files).sort());

  test("finds path and dot spellings of the asked ids, bounded on both sides", async () => {
    const found = await findPluginMentions(repo, [
      asPluginId("db.feed"),
      asPluginId("solo"),
    ]);
    expect(
      found.map((m) => `${m.file}:${m.line} ${m.form} ${m.value}`),
    ).toEqual([
      "plugins/x/core/vocab.ts:1 path plugins/db/plugins/feed",
      "plugins/x/core/vocab.ts:2 path plugins/db/plugins/feed",
      "plugins/x/core/vocab.ts:3 dot db.feed",
      "plugins/y/CLAUDE.md:1 path plugins/db/plugins/feed",
      "plugins/y/CLAUDE.md:1 dot db.feed",
      "plugins/y/top.ts:1 path plugins/solo",
    ]);
    for (const m of found) {
      const text = files[m.file]!;
      expect(text.slice(m.range.start, m.range.end)).toBe(m.value);
    }
  });

  test("no ids, no mentions", async () => {
    expect(await findPluginMentions(repo, [])).toEqual([]);
  });
});
