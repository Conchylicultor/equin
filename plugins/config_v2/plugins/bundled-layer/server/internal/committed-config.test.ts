// The committed layer a browser host bundles, over the REAL repo `config/`
// (read off disk — Bun has no `import.meta.glob` — into the same
// `committedFilesFromMap` the bundle feeds).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APP_SCOPE_DIR,
  committedDocument,
  committedFilesFromMap,
  parseConfigFile,
} from "@plugins/config_v2/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { reorderableSlots } from "@plugins/reorder/server/testing";

const CONFIG_DIR = join(REPO_ROOT, "config");
const raw = new Map<string, string>();
for (const rel of readdirSync(CONFIG_DIR, { recursive: true }) as string[]) {
  if (rel.endsWith(".jsonc") && statSync(join(CONFIG_DIR, rel)).isFile())
    raw.set(rel, readFileSync(join(CONFIG_DIR, rel), "utf8"));
}
const files = committedFilesFromMap(raw);

describe("the committed config layer", () => {
  test("every file parses, with its header (indexing proved each is a layout path)", () => {
    expect(raw.size).toBeGreaterThan(0);
    for (const [rel, text] of raw) {
      expect(() => parseConfigFile(text, rel)).not.toThrow();
    }
  });

  test("every reorderable slot's directive is committed with its arrangement", () => {
    // The regression: the page-side layer used to drop a document equal to its
    // origin, so a demo's slots fell back to `[]` defaults.
    const problems: string[] = [];
    for (const s of reorderableSlots) {
      const storePath = `${asPath(asPluginId(s.pluginId))}/${s.configName}.jsonc`;
      const doc = committedDocument(storePath, files);
      const origin = files.read({ storePath, file: "origin" });
      if (doc === undefined || origin === null) {
        problems.push(`${storePath}: not committed`);
        continue;
      }
      const originItems = (
        parseConfigFile(origin, storePath).content as { items?: unknown[] }
      ).items;
      const items = (doc.base as { items?: unknown[] }).items;
      if (!Array.isArray(items)) problems.push(`${storePath}: no items`);
      else if (items.length === 0 && (originItems?.length ?? 0) > 0)
        problems.push(`${storePath}: empty, its origin is not`);
    }
    expect(problems).toEqual([]);
  });

  test("every committed @app delta is a scope of its document", () => {
    // `<hier>/@app/<id>/<name>.jsonc` (a delta; no scoped origin is committed).
    const deltas = [...raw.keys()].flatMap((rel) => {
      const parts = rel.split("/");
      const at = parts.indexOf(APP_SCOPE_DIR);
      if (at < 0) return [];
      const name = parts.at(-1)!;
      expect(name.endsWith(".origin.jsonc")).toBe(false);
      return [
        {
          storePath: [...parts.slice(0, at), name].join("/"),
          appId: parts[at + 1]!,
        },
      ];
    });
    expect(deltas.length).toBeGreaterThan(0);
    for (const { storePath, appId } of deltas) {
      const doc = committedDocument(storePath, files);
      expect(Object.keys(doc?.scopes ?? {})).toContain(appId);
    }
  });
});
