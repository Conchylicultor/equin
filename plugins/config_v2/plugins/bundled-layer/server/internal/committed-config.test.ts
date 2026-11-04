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
  OWNER_CONFIG_DIR,
  parseConfigFile,
  SHIPPING_CONFIG_DIR,
} from "@plugins/config_v2/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { reorderableSlots } from "@plugins/reorder/server/testing";

function readLayer(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (rel.endsWith(".jsonc") && statSync(join(dir, rel)).isFile())
      out.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return out;
}

// What the bundle globs: `/config/**/*.jsonc`, the shipping layer.
const raw = readLayer(join(REPO_ROOT, SHIPPING_CONFIG_DIR));
const files = committedFilesFromMap(raw);
const owner = readLayer(join(REPO_ROOT, OWNER_CONFIG_DIR));

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

describe("the owner's layer stays out of what a browser host bundles", () => {
  test("the owner commits overrides only, each over a shipping origin", () => {
    expect(owner.size).toBeGreaterThan(0);
    for (const rel of owner.keys()) {
      expect(rel).not.toMatch(/\.(origin|ancestor)\.jsonc$/);
      const origin = rel.replace(/\.jsonc$/, ".origin.jsonc");
      expect(raw.has(origin) || rel.includes(`/${APP_SCOPE_DIR}/`)).toBe(true);
    }
  });

  test("no owner override is also in the shipping layer, and no owner value resolves from it", () => {
    for (const [rel, text] of owner) {
      expect(raw.has(rel)).toBe(false);
      const ownerDoc = parseConfigFile(text, rel).content as object;
      const scope = new RegExp(`/${APP_SCOPE_DIR}/([^/]+)/`).exec(rel);
      const storePath = scope ? rel.replace(scope[0], "/") : rel;
      const shipped = committedDocument(storePath, files);
      // A scoped delta: the shipped scope does not carry the owner's fields.
      const resolved = scope ? shipped?.scopes[scope[1]!] : shipped?.base;
      expect(resolved).not.toMatchObject(ownerDoc);
    }
  });
});
