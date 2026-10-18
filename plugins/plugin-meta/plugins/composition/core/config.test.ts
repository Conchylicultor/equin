/**
 * Pure-logic tests for the compositions config: the seeded `default` items parse
 * against the descriptor schema, map to valid `CompositionManifest`s via the
 * mapper, and the agent-manager full-vs-lean pair realises the vision's anchor
 * demo (their flattened `selectedContributors` set-difference IS exactly the
 * self-improvement PACK, now pulled in via first-class `extends`). No generated
 * registry, no server. Run with:
 *   bun test plugins/plugin-meta/plugins/composition/core/config.test.ts
 */
import { test, expect } from "bun:test";
import { flattenManifest } from "@plugins/plugin-meta/plugins/closure/core";
import { compositionsConfig } from "./config";
import {
  manifestItemToManifest,
  type CompositionManifestItem,
} from "./manifest-map";
import {
  BASE_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";

const seeds = compositionsConfig.defaults
  .manifests as CompositionManifestItem[];
const registry = seeds.map(manifestItemToManifest);

const SELF_IMPROVEMENT = [
  "improve.element-picker",
  "review",
  "reports.crash",
  "reports.launch-fix",
  "screenshot.draw-on-app",
];

const byName = (name: string): CompositionManifestItem => {
  const m = seeds.find((x) => x.name === name);
  if (!m) throw new Error(`seed composition "${name}" not found`);
  return m;
};

test("the seeded default parses against the descriptor schema", () => {
  const parsed = compositionsConfig.schema.safeParse(
    compositionsConfig.defaults,
  );
  expect(parsed.success).toBe(true);
});

test("every seed carries a distinct id (array position is the order)", () => {
  const ids = seeds.map((s) => s.id);
  expect(new Set(ids).size).toBe(seeds.length);
});

test("the taxonomy is populated: app, profile, subsystem, and pack seeds all exist", () => {
  const categories = new Set(seeds.map((s) => s.category));
  for (const c of ["app", "profile", "subsystem", "pack"]) {
    expect(categories.has(c)).toBe(true);
  }
  // The two agent-manager flavors are profiles; self-improvement is a pack.
  expect(byName("agent-manager").category).toBe("profile");
  expect(byName("agent-manager-lean").category).toBe("profile");
  expect(byName("self-improvement").category).toBe("pack");
});

test("each seed maps to a valid CompositionManifest via the mapper", () => {
  for (const item of seeds) {
    const m = manifestItemToManifest(item);
    expect(typeof m.name).toBe("string");
    expect(m.name.length).toBeGreaterThan(0);
    expect(Array.isArray(m.entryPoints)).toBe(true);
    expect(Array.isArray(m.selectedContributors)).toBe(true);
    expect(m.selectedContributors.every((id) => typeof id === "string")).toBe(
      true,
    );
    // Only packs (pure contributor sets) may omit entry points.
    if (item.category !== "pack") {
      expect(m.entryPoints.length).toBeGreaterThan(0);
    }
  }
});

test("the agent-runtime bundle aggregates the agent/worktree/git taproots", () => {
  const ar = byName("agent-runtime");
  expect(ar.category).toBe("subsystem");
  // The deep taproots a self-contained app must never reach, listed as
  // whole-subtree (`.**`) entries so an app's hard closure surfaces them for the
  // disjointness check.
  for (const id of [
    "infra.worktree.**",
    "infra.git.git-watcher.**",
    "infra.claude-cli.**",
  ]) {
    expect(ar.entryPoints).toContain(id);
  }
  // Reuses the existing conversations/tasks-domain subsystems via `extends`.
  expect([...ar.extends].sort()).toEqual(["conversations", "tasks-domain"]);
});

test("the website app seed takes the whole site subtree", () => {
  const site = byName("website");
  expect(site.category).toBe("app");
  const m = manifestItemToManifest(site);
  expect(typeof m.name).toBe("string");
  expect(m.name.length).toBeGreaterThan(0);
  // The site is one subtree and nothing subtracted: `.**` takes it whole. The
  // negative this used to carry (`!apps.website.demos.editor-toy.**`) named a
  // plugin that no longer exists, and an entry pattern whose base resolves to
  // nothing is what `composition-closure` rejects — so "no negatives" is the
  // guard, not a detail. Whether the bundle really stays clear of worktree infra
  // is `excludes: ["agent-runtime"]`'s job, asserted in closure.test.ts against a
  // real plugin tree; here we only assert the grammar.
  //
  // `excludes` is read off the CONFIG ITEM, not off `m`: manifestItemToManifest
  // drops it deliberately (the closure engine never reads it).
  const entries = m.entryPoints.map(String);
  expect(entries).toEqual(["apps.website.**"]);
  expect(site.excludes).toContain("agent-runtime");
});

test("served-baseline lists only what BEING SERVED needs", () => {
  // Everything a capability needs at runtime is a derived edge — an import, a
  // token use, or a companion contribution — never a line here. Each entry
  // below is a requirement of being served at all: the app surface, the
  // gateway's health probe (which brings the toast host by import), the runtime
  // theme engine, and the rubber-band that keeps the near-black `html` floor
  // from showing above the page (equin.ai shipped that way).
  const baseline = byName("served-baseline");
  expect([...baseline.entryPoints].map(String).sort()).toEqual(
    [
      "apps-core.layout.**",
      "infra.health.**",
      "primitives.dom.overscroll-hint.**",
      "ui.theme-engine.**",
    ].sort(),
  );
});

test("every seed carries `excludes` and each ref resolves to a real bundle", () => {
  const names = new Set(seeds.map((s) => s.name));
  for (const s of seeds) {
    // The self-containment guard field is present on every seed (default []).
    expect(Array.isArray(s.excludes)).toBe(true);
    // Every declared exclusion names a real composition (the check enforces
    // disjointness against it). No app opts in yet — see config.ts — but the
    // mechanism stays validated.
    for (const ref of s.excludes) expect(names.has(ref)).toBe(true);
  }
});

test("every seed carries `serve` (default off) and the mapper drops it", () => {
  for (const s of seeds) {
    // The serve mode is present on every seed, and nothing ships served: a
    // committed seed that named a cadence would rebuild a namespace on a clean
    // checkout that never asked for one.
    expect(s.serve).toBe("off");
    // Engine-opaque: `manifestItemToManifest` drops it exactly like `category` /
    // `excludes`, so the resolved `CompositionManifest` never carries it.
    const m = manifestItemToManifest(s);
    expect("serve" in m).toBe(false);
  }
});

test("every seed carries `home` and the mapper drops it", () => {
  for (const s of seeds) {
    expect(typeof s.home).toBe("string");
    expect("home" in manifestItemToManifest(s)).toBe(false);
  }
  // The homepage is the composition's call, never load order.
  expect(byName("singularity").home).toBe("home");
  expect(byName("website").home).toBe("website");
});

test("the self-improvement pack holds exactly the self-improvement set", () => {
  const pack = manifestItemToManifest(byName("self-improvement"));
  expect([...pack.selectedContributors].map(String).sort()).toEqual(
    [...SELF_IMPROVEMENT].sort(),
  );
  expect(pack.entryPoints.length).toBe(0);
});

test("anchor demo: flattened full \\ lean is exactly the self-improvement pack", () => {
  // Full extends the self-improvement pack; lean does not. After flattening the
  // `extends` chain against the registry, the contributor set-difference is the
  // pack's contributors (order-independent).
  const full = flattenManifest(
    manifestItemToManifest(byName("agent-manager")),
    registry,
  );
  const lean = flattenManifest(
    manifestItemToManifest(byName("agent-manager-lean")),
    registry,
  );

  const diff = full.selectedContributors.filter(
    (c) => !lean.selectedContributors.includes(c),
  );
  expect([...diff].map(String).sort()).toEqual([...SELF_IMPROVEMENT].sort());

  // Lean's contributors are a strict subset of full's flattened contributors.
  for (const c of lean.selectedContributors) {
    expect(full.selectedContributors).toContain(c);
  }
});

test("the main app is seeded exactly once, as the root composition", () => {
  // `singularity` is an ORDINARY entry in this registry — that is the whole point
  // of the seed. Exactly one row carries the id, because the id is a namespace and
  // because `plugins-registry-in-sync` resolves "the main composition" by finding
  // it: two rows (or none) and that equivalence proof stops being about main.
  const mainRows = seeds.filter((s) => s.id === MAIN_COMPOSITION_ID);
  expect(mainRows.length).toBe(1);
  const main = mainRows[0]!;

  // The ROOT pattern: every plugin. Spelled `**` rather than an enumeration of
  // top-level ids (which would be a drift list — a new top-level plugin would
  // silently fall out of main) and rather than a manifest boolean (which would put
  // an "except for main" branch back inside the closure engine).
  expect(main.entryPoints).toEqual(["**"]);

  // Deliberately NOT `["served-baseline"]`. `**` already covers everything the
  // baseline forces in, and extending it would push served-baseline's bases into
  // the engine's `named` set — the set the negative pass refuses to trim — which
  // would permanently shield them from any future `!x.**`, for no gain.
  expect(main.extends).toEqual([]);
});

test("the base-exclusions row is seeded exactly once and holds only negatives", () => {
  // Exactly one row, for the same reason main has exactly one: `flattenManifest`
  // resolves it BY NAME, so a second row would silently shadow the first and a
  // missing one would make every inherited exclusion vanish without a word.
  const rows = seeds.filter((s) => s.id === BASE_EXCLUSIONS_ID);
  expect(rows.length).toBe(1);
  const base = rows[0]!;
  expect(base.name).toBe(BASE_EXCLUSIONS_ID);

  // NEGATIVES ONLY. Every composition inherits this row unconditionally, so a
  // positive here would force a plugin INTO every bundle from a place nobody
  // looks — that is `served-baseline`'s job, done through `extends` where the
  // opting-in row shows it.
  expect(base.entryPoints.length).toBeGreaterThan(0);
  for (const p of base.entryPoints) expect(p.startsWith("!")).toBe(true);
  expect(base.selectedContributors).toEqual([]);

  // Not servable: the row resolves to an empty bundle, so there is nothing a
  // serve build could put behind a `base-exclusions` namespace.
  expect(base.serve).toBe("off");
});

test("the base-exclusions row carries the migrated plugin-changes exclusion", () => {
  // The replacement for the `singularity.disabled: true` flag that used to live
  // in plugins/review/plugins/plugin-changes/package.json. The cascade to the two
  // sub-plugins and the nine render-diff adapters is the engine's job — asserted
  // against a real plugin tree in closure.test.ts; here we pin the declaration.
  const base = byName(BASE_EXCLUSIONS_ID);
  expect(base.entryPoints).toContain("!review.plugin-changes.**");
});

test("the base-exclusions row keeps the browser-only host-service providers out of every app", () => {
  // A desktop backend provides these services from machine halves; booting a
  // second provider of one fails boot, so no app may ship them by default.
  const base = byName(BASE_EXCLUSIONS_ID);
  for (const provider of [
    "database.pglite",
    "infra.jobs.in-process",
    "infra.attachments.memory-blobs",
    "primitives.log-channels.memory-persistence",
    "tasks.tasks-core.seeded-push-ledger",
  ]) {
    expect(base.entryPoints).toContain(`!${provider}.**`);
  }
});

test("main's entry points stay exactly `**` — the exclusion lives on the base row", () => {
  // The negative deliberately does NOT go on main's row. Written there it would
  // hold for main alone, and any other composition reaching the same plugins
  // would ship what the repo decided it does not want.
  expect(byName(MAIN_COMPOSITION_ID).entryPoints).toEqual(["**"]);
});
