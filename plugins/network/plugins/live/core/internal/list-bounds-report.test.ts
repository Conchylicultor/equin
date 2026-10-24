/**
 * The bare-list sweep: every `liveValue`, `liveCollection`, union arm
 * (`liveArm`) and extension shape (`defineExtensionShape` — its `exposes`
 * fields fold into every row of its parent's lists) the repo declares, imported for real (each declaring `core/` /
 * `shared/` module, through barrel-import's stubs) and its declared `shape`
 * read — the lists a value's payload, a collection's row or an arm's slice (a
 * `jsonField({ schema })`, a string list) holds with no bound. There must be none: the declaration itself
 * refuses one (`declaredShape`, a `BareListError` at module evaluation, which
 * fails the import here), and this sweep proves every declaration the source
 * names was reached — so none passes unseen
 * (research/2026-10-22-global-live-bounds-independent-of-freshness.md, B5).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import type { ListShape } from "@plugins/packages/plugins/list-bound/core";
import type { LiveValueShape } from "./live-value";

const ROOT = resolve(import.meta.dir, "../../../../../..");

/** A declaration statement (`… = liveValue("key"` / `liveCollection("key"`), never a doc comment's example. */
const DECLARATION_RE =
  /=\s*live(?:Value|Collection)\s*(?:<[^(]*>)?\(\s*"([^"]+)"/;

/** A collection whose `liveCollection(` and key sit on two lines (`(\n  "key",`). */
const SPLIT_DECLARATION_RE =
  /=\s*live(?:Value|Collection)\s*(?:<[^(]*>)?\(\s*$/;
const SPLIT_KEY_RE = /^\s*"([^"]+)"\s*,/;

/** A union arm's declaration (`… = liveArm(`) — its key is its union's and its kind, rarely literals. */
const ARM_DECLARATION_RE = /=\s*liveArm\s*(?:<[^(]*>)?\(/;

/** An extension shape's declaration (`… = defineExtensionShape(`) — an exposure refuses a bare list when it is declared. */
const SHAPE_DECLARATION_RE = /=\s*defineExtensionShape\s*(?:<[^(]*>)?\(/;

interface DeclaringModule {
  path: string;
  keys: string[];
  arms: number;
  shapes: number;
}

/** The non-test modules under a `core/` or `shared/` folder that declare a `liveValue`, a `liveCollection`, a `liveArm` or an extension shape. */
function declaringModules(): DeclaringModule[] {
  const out: DeclaringModule[] = [];
  for (const rel of new Bun.Glob("plugins/**/{core,shared}/**/*.ts").scanSync(
    ROOT,
  )) {
    if (
      rel.includes("/node_modules/") ||
      rel.includes("/testing/") ||
      rel.includes("/__tests__/") ||
      rel.endsWith(".test.ts") ||
      rel.endsWith(".d.ts")
    ) {
      continue;
    }
    const path = resolve(ROOT, rel);
    const keys: string[] = [];
    let arms = 0;
    let shapes = 0;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trimStart();
      if (t.startsWith("*") || t.startsWith("//")) return;
      if (ARM_DECLARATION_RE.test(line)) arms++;
      if (SHAPE_DECLARATION_RE.test(line)) shapes++;
      const m = DECLARATION_RE.exec(line);
      if (m !== null) keys.push(m[1]!);
      else if (SPLIT_DECLARATION_RE.test(line)) {
        const k = SPLIT_KEY_RE.exec(lines[i + 1] ?? "");
        if (k !== null) keys.push(k[1]!);
      }
    });
    if (keys.length > 0 || arms > 0 || shapes > 0) {
      out.push({ path, keys, arms, shapes });
    }
  }
  return out;
}

interface DeclaredValue {
  key: string;
  live: "value";
  shape: LiveValueShape;
  meta?: unknown;
}

function isDeclaredValue(v: unknown): v is DeclaredValue {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { live?: unknown }).live === "value" &&
    typeof (v as { key?: unknown }).key === "string" &&
    typeof (v as { shape?: unknown }).shape === "object"
  );
}

/** A `liveCollection` declaration: its `:rows` sibling, and its row's `shape`. */
interface DeclaredCollection {
  key: string;
  rows: { key: string };
  shape: ListShape;
}

function isDeclaredCollection(v: unknown): v is DeclaredCollection {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { key?: unknown }).key === "string" &&
    typeof (v as { rows?: { key?: unknown } }).rows?.key === "string" &&
    typeof (v as { shape?: unknown }).shape === "object"
  );
}

/** A union arm (`liveArm`): its owner names its union and kind, and its slice's `shape`. */
interface DeclaredArm {
  owner: { kind: "arm"; collection: string; arm: string };
  shape: ListShape;
}

/** An extension shape: `exposure` is its resolved exposure, or `null` (it exposes nothing). */
function isExtensionShape(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.hasOwn(v, "exposure") &&
    typeof (v as { schema?: unknown }).schema === "object"
  );
}

function isDeclaredArm(v: unknown): v is DeclaredArm {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { owner?: { kind?: unknown } }).owner?.kind === "arm" &&
    typeof (v as { shape?: unknown }).shape === "object"
  );
}

describe("list bounds — every declared liveValue, liveCollection, liveArm and extension shape", () => {
  test("holds no bare list", async () => {
    registerBarrelStubs(ROOT);
    const modules = declaringModules();
    const values = new Map<string, DeclaredValue | DeclaredCollection>();
    const arms = new Map<string, DeclaredArm>();
    const armsMissing: string[] = [];
    let shapes = 0;
    for (const { path, arms: declared, shapes: declaredShapes } of modules) {
      // An exposure holding a bare list throws here, at the import.
      const mod = await importBarrel(path);
      let found = 0;
      let foundShapes = 0;
      for (const exported of Object.values(mod)) {
        if (isExtensionShape(exported)) {
          foundShapes++;
          continue;
        }
        if (isDeclaredArm(exported)) {
          arms.set(
            `${exported.owner.collection}/${exported.owner.arm}`,
            exported,
          );
          found++;
          continue;
        }
        if (isDeclaredCollection(exported)) {
          values.set(exported.key, exported);
          continue;
        }
        if (!isDeclaredValue(exported)) continue;
        values.set(exported.key, exported);
        // A paged value's meta sibling is a value of its own.
        if (isDeclaredValue(exported.meta)) {
          values.set(exported.meta.key, exported.meta);
        }
      }
      if (found < declared) {
        armsMissing.push(
          `${declared - found} liveArm (${path.slice(ROOT.length + 1)})`,
        );
      }
      if (foundShapes < declaredShapes) {
        armsMissing.push(
          `${declaredShapes - foundShapes} defineExtensionShape (${path.slice(ROOT.length + 1)})`,
        );
      }
      shapes += foundShapes;
    }

    // Every declaration the source names was found — so a value the report
    // could not reach (not exported) fails here instead of passing unseen.
    const missing = modules
      .flatMap((m) => m.keys.map((key) => ({ key, path: m.path })))
      .filter(({ key }) => !values.has(key))
      .map(({ key, path }) => `${key} (${path.slice(ROOT.length + 1)})`);
    expect([...missing, ...armsMissing]).toEqual([]);

    const bare = [
      ...[...values.values()]
        .filter((v) => v.shape.bare.length > 0)
        .map(
          (v) =>
            `${"live" in v ? "" : "collection "}${v.key} → ${v.shape.bare.join(", ")}`,
        ),
      ...[...arms.entries()]
        .filter(([, a]) => a.shape.bare.length > 0)
        .map(([k, a]) => `arm ${k} → ${a.shape.bare.join(", ")}`),
    ].sort();
    console.log(
      `[list-bounds] ${values.size + arms.size} declarations (${arms.size} arms), ${shapes} extension shapes, ${bare.length} holding a bare list` +
        (bare.length > 0 ? `:\n  ${bare.join("\n  ")}` : ""),
    );
    expect(bare).toEqual([]);
  }, 600_000);
});
