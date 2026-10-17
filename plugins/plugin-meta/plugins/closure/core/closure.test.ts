/**
 * Engine verification against the REAL plugin tree. Builds the tree once
 * (`skipBarrelImport: true`, so it works at build time / browser-less), classifies
 * edges, and resolves the `agent-manager` composition under the CONSERVATIVE opt-in
 * model, asserting the closure topology the design calls out. Run with `bun test`
 * from the repo root.
 *
 * Conservative model: NOTHING soft is included by default. The default bundle is the
 * pure hard closure of the entries; soft contributors become reviewable `available`
 * options the human/agent selects explicitly.
 */
import { test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { join } from "path";
import {
  buildPluginTree,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { BASE_EXCLUSIONS_ID } from "@plugins/infra/plugins/namespace/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import { classifyEdges } from "./classify-edges";
import {
  resolveComposition,
  removalClosure,
  expandEntrySeeds,
} from "./resolve-composition";
import { parseEntryPattern, matchEntryPattern } from "./entry-pattern";
import { flattenManifest } from "./flatten-manifest";
import { explainInclusion } from "./explain";
import { impactOfPruning, impactOfSelecting } from "./impact";
import type { EdgeGraph, CompositionManifest } from "./types";

const AGENT_MANAGER = asPluginId("apps.agent-manager");
const AGENT_MANAGER_SHELL = asPluginId("apps.agent-manager.shell");
const SONATA = asPluginId("apps.sonata");
const SHELL = asPluginId("shell");
// A real `available` self-improvement contributor into the agent-manager bundle
// (verified via probe: `review` soft-contributes to `primitives.pane`, which is
// in the default hard closure of the entry).
const REVIEW = asPluginId("review");

const manifest: CompositionManifest = {
  name: "agent-manager",
  entryPoints: [asPluginId("apps.agent-manager.**")],
  selectedContributors: [],
};

/**
 * `expandEntrySeeds` takes a whole manifest (its negative pass reads
 * `selectedContributors` too). These grammar tests only vary the patterns, so
 * wrap the boilerplate once.
 */
function expand(
  entryPoints: string[],
  g: EdgeGraph,
  selectedContributors: string[] = [],
) {
  return expandEntrySeeds(
    {
      name: "probe",
      entryPoints,
      selectedContributors: selectedContributors.map(asPluginId),
    },
    g,
  );
}

let tree: PluginTree;
let graph: EdgeGraph;

// The `beforeAll` below builds the FULL faceted plugin tree off disk (~4–6s, and
// far more on a loaded machine). Bun's default per-hook timeout is 5s, so this
// suite was intermittently failing the hook — surfacing as a bogus "(fail)
// (unnamed)" with the file's other tests never running, which reads as a real
// regression rather than a timeout. Give the disk walk honest headroom.
setDefaultTimeout(60_000);

beforeAll(async () => {
  const root = (await Bun.$`git rev-parse --show-toplevel`.text()).trim();
  tree = await buildPluginTree(join(root, "plugins"), {
    skipBarrelImport: true,
    facets: true,
  });
  graph = classifyEdges(tree);
});

function hasNode(id: string): boolean {
  for (const n of tree.byDir.values()) if (n.id === id) return true;
  return false;
}

test("the anchor plugin ids exist in the real tree", () => {
  for (const id of [AGENT_MANAGER, SONATA, SHELL, REVIEW]) {
    expect(hasNode(id)).toBe(true);
  }
});

test("default composition: small hard-only bundle + entry/required classification", () => {
  const comp = resolveComposition(graph, manifest);

  // The entry itself.
  expect(comp.membership.get(AGENT_MANAGER)).toBe("entry");

  // shell is hard-imported transitively from the entry's subtree ⇒ required (locked).
  expect(comp.bundle.has(SHELL)).toBe(true);
  expect(comp.membership.get(SHELL)).toBe("required");

  // Conservative INVARIANT (robust to tree drift — the exact count grows as main
  // adds plugins): with NO selected contributors the bundle is exactly the hard
  // closure of the entries, so every bundled node is `entry` or `required`, and
  // nothing soft is pulled in (zero contributor / via-contributor).
  for (const id of comp.bundle) {
    expect(["entry", "required"]).toContain(comp.membership.get(id)!);
  }
  const states = [...comp.membership.values()];
  expect(states.filter((s) => s === "contributor")).toHaveLength(0);
  expect(states.filter((s) => s === "via-contributor")).toHaveLength(0);

  // membership is total — every tree node has a state.
  expect(comp.membership.size).toBe(tree.byDir.size);

  // No selections ⇒ none redundant.
  expect(comp.redundantSelections).toEqual([]);

  // The bundle is a small fraction of the tree — nowhere near the ~64% the old
  // opt-out model produced.
  expect(comp.bundle.size).toBeLessThan(tree.byDir.size / 2);
});

// THE CONSERVATIVE WIN: under the old opt-out model, selecting `apps.agent-manager`
// dragged in ~64% of the repo (every app registered into the `Apps.App` switcher
// slot). Now nothing soft is auto-included, so sonata's whole subtree stays out of
// the bundle entirely — its sub-plugins are `excluded` or `available` (reviewable
// options), never bundled.
test("conservative: sonata's subtree is NOT bundled", () => {
  const comp = resolveComposition(graph, manifest);

  // The empty umbrella node itself is not bundled.
  expect(comp.bundle.has(SONATA)).toBe(false);
  expect(comp.membership.get(SONATA)).toBe("excluded");

  // Every sonata node (umbrella + sub-plugins) is out of the bundle: either
  // `excluded` or `available`. None is contributor/required/entry/via-contributor.
  const sonataNodes = [...tree.byDir.values()]
    .map((n) => n.id)
    .filter((id) => id === "apps.sonata" || id.startsWith("apps.sonata."));
  expect(sonataNodes.length).toBeGreaterThan(0);
  for (const id of sonataNodes) {
    expect(comp.bundle.has(id)).toBe(false);
    expect(["excluded", "available"]).toContain(comp.membership.get(id)!);
  }
});

// ── entry-pattern grammar: `.**` subtree opt-in + `!` negation ────────────────

test("parseEntryPattern splits negation / base / subtree", () => {
  expect(parseEntryPattern("apps.website")).toMatchObject({
    kind: "id",
    negate: false,
    base: "apps.website",
    subtree: false,
  });
  expect(parseEntryPattern("apps.website.**")).toMatchObject({
    kind: "id",
    negate: false,
    base: "apps.website",
    subtree: true,
  });
  expect(parseEntryPattern("!apps.website.demos.**")).toMatchObject({
    kind: "id",
    negate: true,
    base: "apps.website.demos",
    subtree: true,
  });
  // raw is preserved verbatim.
  expect(parseEntryPattern("!apps.website.demos.**").raw).toBe(
    "!apps.website.demos.**",
  );
});

// ── the root `**` pattern: every plugin ──────────────────────────────────────

test("parseEntryPattern recognises the root `**` form (and never throws on `!**`)", () => {
  expect(parseEntryPattern("**")).toEqual({
    kind: "root",
    negate: false,
    raw: "**",
  });
  // `!**` is a pathology the composition-closure check refuses — but PARSING it
  // must stay total, because Studio renders user-typed patterns.
  expect(parseEntryPattern("!**")).toEqual({
    kind: "root",
    negate: true,
    raw: "!**",
  });
});

test("matchEntryPattern on root covers every node in the graph", () => {
  const matched = matchEntryPattern(parseEntryPattern("**"), graph);
  expect(matched.size).toBe(tree.byDir.size);
  for (const n of tree.byDir.values()) expect(matched.has(n.id)).toBe(true);
});

// THE LOAD-BEARING INVARIANT. `named` is the protected set the negative pass
// refuses to trim. If `**` named everything, `!x.**` could never remove anything
// and the composition-closure check would reject every negative under it as dead.
// Root means "everything is in", not "everything is explicitly demanded".
test("root seeds every id and NAMES NONE", () => {
  const { seeds, named } = expand(["**"], graph);
  expect(seeds.size).toBe(tree.byDir.size);
  for (const n of tree.byDir.values()) expect(seeds.has(n.id)).toBe(true);
  expect(named.size).toBe(0);
});

test("resolveComposition under `**`: everything bundled + required, nothing available", () => {
  const comp = resolveComposition(graph, {
    name: "everything",
    entryPoints: [asPluginId("**")],
    selectedContributors: [],
  });
  expect(comp.bundle.size).toBe(tree.byDir.size);
  for (const n of tree.byDir.values()) {
    expect(comp.bundle.has(n.id)).toBe(true);
    // Nothing is `entry` — root names nothing — so every bundled node is `required`.
    expect(comp.membership.get(n.id)).toBe("required");
  }
  // Nothing is outside the bundle, so the reviewable option frontier is empty.
  expect(comp.available).toEqual([]);
});

// Phase-7 forward guard: `**` plus branch negatives is how `singularity.disabled`
// was replaced, so a negative MUST still bite under a root positive.
test("a negative trims its subtree even under a root positive", () => {
  const { seeds, negated } = expand(["**", "!apps.sonata.**"], graph);
  const sonataIds = [...tree.byDir.values()]
    .map((n) => n.id)
    .filter((id) => id === SONATA || id.startsWith(`${SONATA}.`));
  expect(sonataIds.length).toBeGreaterThan(1); // umbrella + sub-plugins
  for (const id of sonataIds) expect(seeds.has(id)).toBe(false);
  expect(seeds.has(AGENT_MANAGER)).toBe(true);

  // `negated` is what the manifest ASSERTED must go — the pattern's matches,
  // not the cascade.
  expect([...negated].sort()).toEqual([...sonataIds].sort());

  // The seed set is exactly everything minus the REMOVAL closure of those ids:
  // sonata's own nodes plus whatever transitively imports them (the website
  // demos embed the real Sonata keyboard, so the cascade reaches further than
  // the branch itself — which is the behaviour that makes a negative honest).
  const cascade = removalClosure(sonataIds.map(asPluginId), graph);
  expect(seeds.size).toBe(tree.byDir.size - cascade.size);
  for (const id of cascade) expect(seeds.has(id)).toBe(false);
});

// Documents the pathology `composition-closure` refuses: `!**` parses fine and
// deletes every seed, leaving a composition that builds to nothing.
test("a lone `!**` seeds nothing", () => {
  const { seeds, named } = expand(["!**"], graph);
  expect(seeds.size).toBe(0);
  expect(named.size).toBe(0);
});

// (i) A bare id seeds ONLY the node + its hard closure — no implicit subtree.
test("bare entry seeds node + hard deps only (subtree NOT bundled)", () => {
  const bare: CompositionManifest = {
    name: "agent-manager-bare",
    entryPoints: [AGENT_MANAGER],
    selectedContributors: [],
  };
  const comp = resolveComposition(graph, bare);

  // The umbrella node itself is the entry.
  expect(comp.membership.get(AGENT_MANAGER)).toBe("entry");
  // A no-runtime umbrella hard-imports nothing, so the runtime-bearing `.shell`
  // sub-plugin is NOT seeded by a bare entry ⇒ not bundled.
  expect(comp.bundle.has(AGENT_MANAGER_SHELL)).toBe(false);
  expect(comp.bundle.has(SHELL)).toBe(false);

  // matchEntryPattern on a bare pattern is just the base.
  expect([
    ...matchEntryPattern(parseEntryPattern("apps.agent-manager"), graph),
  ]).toEqual([AGENT_MANAGER]);
});

// (ii) `.**` seeds the whole subtree — shell present and required.
test(".** entry seeds the whole subtree (shell present, required)", () => {
  const comp = resolveComposition(graph, manifest); // entryPoints: ["apps.agent-manager.**"]
  expect(comp.membership.get(AGENT_MANAGER)).toBe("entry");
  expect(comp.bundle.has(AGENT_MANAGER_SHELL)).toBe(true);
  expect(comp.bundle.has(SHELL)).toBe(true);
  expect(comp.membership.get(SHELL)).toBe("required");

  // The subtree match includes the `.shell` sub-plugin.
  const matched = matchEntryPattern(
    parseEntryPattern("apps.agent-manager.**"),
    graph,
  );
  expect(matched.has(AGENT_MANAGER)).toBe(true);
  expect(matched.has(AGENT_MANAGER_SHELL)).toBe(true);
});

// (iii) A negative trims a `.**`-implicit id — but an explicit positive of the SAME
// id survives (additivity: a named positive is protected from any negative).
test("negation trims a .**-implicit id, but an explicit positive survives", () => {
  // root has two children a, b. `root.**` pulls both in implicitly.
  const g = syntheticGraph(["root", "root.a", "root.b"], [], {
    root: ["root.a", "root.b"],
  });

  // `.**` then `!root.a` ⇒ a is trimmed (implicit only).
  const trimmed = expand(["root.**", "!root.a"], g);
  expect(trimmed.seeds.has(asPluginId("root.a"))).toBe(false);
  expect(trimmed.seeds.has(asPluginId("root.b"))).toBe(true);
  expect(trimmed.seeds.has(asPluginId("root"))).toBe(true);

  // Same negative, but `root.a` is ALSO named as an explicit positive ⇒ it survives.
  const survives = expand(["root.**", "root.a", "!root.a"], g);
  expect(survives.seeds.has(asPluginId("root.a"))).toBe(true);
  expect(survives.named.has(asPluginId("root.a"))).toBe(true);
});

// (iv) A negative takes its importers with it — that is what stops it from being
// silently undone. `root.keep` imports an id under the negated branch, so it
// leaves too, and nothing drags the branch back.
test("a negative takes an unprotected importer with it", () => {
  const comp = resolveComposition(importerGraph(), {
    name: "cascades",
    entryPoints: ["root.**", "!root.drop.**"],
    selectedContributors: [],
  });

  expect(comp.bundle.has(asPluginId("root.drop"))).toBe(false);
  expect(comp.bundle.has(asPluginId("root.drop.inner"))).toBe(false);
  // The importer is not a sibling that survives — it breaks without what it
  // imports, so it goes.
  expect(comp.bundle.has(asPluginId("root.keep"))).toBe(false);
  // The exclusion took effect, so there is nothing to report.
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// (iv-b) FAIL-LOUD, in the one case the cascade cannot resolve: the importer is
// explicitly NAMED, so it is protected from removal, survives, and re-adds the
// negated id through `hardClosure`. Naming an importer is not a request for what
// it imports — so the engine reports the contradiction instead of picking a side.
test("a PROTECTED importer re-adds the negated id, and that is reported", () => {
  const comp = resolveComposition(importerGraph(), {
    name: "fail-loud",
    entryPoints: ["root.**", "root.keep", "!root.drop.**"],
    selectedContributors: [],
  });

  // `root.keep` is named ⇒ protected ⇒ survives, and its hard import comes back.
  expect(comp.bundle.has(asPluginId("root.keep"))).toBe(true);
  expect(comp.bundle.has(asPluginId("root.drop.inner"))).toBe(true);
  // The branch node itself has no importer, so it does leave.
  expect(comp.bundle.has(asPluginId("root.drop"))).toBe(false);

  // The hole is named, with the chain that made it.
  expect(comp.unsatisfiedExclusions).toHaveLength(1);
  const [u] = comp.unsatisfiedExclusions;
  expect(u!.target).toBe(asPluginId("root.drop.inner"));
  expect(u!.path.origin).toBe(asPluginId("root.keep"));
  expect(u!.path.steps).toEqual([
    {
      from: asPluginId("root.keep"),
      to: asPluginId("root.drop.inner"),
      kind: "hard",
    },
  ]);
});

/** root.** over children keep / drop, where keep hard-imports into the drop branch. */
function importerGraph(): EdgeGraph {
  return syntheticGraph(
    ["root", "root.keep", "root.drop", "root.drop.inner"],
    [["root.keep", "root.drop.inner"]], // keep imports an id under the negated branch
    {
      root: ["root.keep", "root.drop", "root.drop.inner"],
      "root.drop": ["root.drop.inner"],
    },
  );
}

// (v) Real-tree `website`-shaped manifest: `.**` minus a branch negative excludes
// every editor-toy id and keeps the rest of the website subtree.
test("website-shaped manifest: .** minus negatives drops a branch and its importers", () => {
  const websiteManifest: CompositionManifest = {
    name: "website",
    entryPoints: [
      asPluginId("apps.website.**"),
      asPluginId("!apps.website.pages.story.**"),
    ],
    selectedContributors: [],
  };
  const comp = resolveComposition(graph, websiteManifest);

  // Every story id is OUT of the bundle…
  const storyIds = [...tree.byDir.values()]
    .map((n) => n.id)
    .filter(
      (id) =>
        id === "apps.website.pages.story" ||
        id.startsWith("apps.website.pages.story."),
    );
  expect(storyIds.length).toBeGreaterThan(0);
  for (const id of storyIds) {
    expect(comp.bundle.has(asPluginId(id))).toBe(false);
  }
  // …and so is the landing section that imports it (a negative cascades to
  // importers), while the landing itself stays.
  expect(comp.bundle.has(asPluginId("apps.website.landing.story-link"))).toBe(
    false,
  );

  // Kept website ids ARE bundled.
  expect(comp.bundle.has(asPluginId("apps.website.shell"))).toBe(true);
  expect(comp.bundle.has(asPluginId("apps.website.landing"))).toBe(true);
  expect(comp.bundle.has(asPluginId("apps.website.pages.apps"))).toBe(true);
});

test("available frontier: reviewable soft options into the bundle", () => {
  const comp = resolveComposition(graph, manifest);

  // There ARE reviewable options.
  expect(comp.available.length).toBeGreaterThan(0);

  // available is sorted + deduped.
  expect([...comp.available].sort()).toEqual(comp.available);
  expect(new Set(comp.available).size).toBe(comp.available.length);

  // A known self-improvement contributor (`review`) soft-contributes into the bundle
  // ⇒ it's an `available` option, not bundled.
  expect(comp.available).toContain(REVIEW);
  expect(comp.bundle.has(REVIEW)).toBe(false);
  expect(comp.membership.get(REVIEW)).toBe("available");
});

test("opt-in: selecting an available contributor pulls it into the bundle", () => {
  const comp = resolveComposition(graph, manifest);
  // Pick a real available id and select it.
  const X = comp.available[0]!;
  expect(comp.membership.get(X)).toBe("available");

  const selected = resolveComposition(graph, {
    ...manifest,
    selectedContributors: [X],
  });
  expect(selected.bundle.has(X)).toBe(true);
  expect(selected.membership.get(X)).toBe("contributor");

  // impactOfSelecting reports the cost of adding X — non-empty and includes X itself.
  const impact = impactOfSelecting(graph, manifest, X);
  expect(impact.length).toBeGreaterThan(0);
  expect(impact).toContain(X);
});

test("redundantSelections: selecting a required node is a surfaced no-op", () => {
  const withRedundant: CompositionManifest = {
    ...manifest,
    selectedContributors: [SHELL],
  };
  const base = resolveComposition(graph, manifest);
  const comp = resolveComposition(graph, withRedundant);

  // shell was already required; selecting it changes nothing about the bundle.
  expect(comp.bundle.has(SHELL)).toBe(true);
  expect(comp.membership.get(SHELL)).toBe("required");
  expect(comp.redundantSelections).toContain(SHELL);
  // Bundle unchanged.
  expect(comp.bundle.size).toBe(base.bundle.size);
});

test("explainInclusion for a required node returns an all-hard path from the entry", () => {
  const path = explainInclusion(graph, manifest, SHELL);
  expect(path).not.toBeNull();
  expect(path!.target).toBe(SHELL);
  expect(path!.originKind).toBe("entry");
  // The hard chain originates at the runtime-bearing sub-plugin of the entry
  // umbrella (the umbrella itself imports nothing).
  expect(path!.origin).toBe(AGENT_MANAGER_SHELL);
  const steps = path!.steps;
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) expect(step.kind).toBe("hard");
  // Path is contiguous: first step starts at the origin seed, last lands on target.
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  expect(first.from).toBe(AGENT_MANAGER_SHELL);
  expect(last.to).toBe(SHELL);
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i]!.from).toBe(steps[i - 1]!.to);
  }
});

test("impactOfPruning a hard-required node drops nothing", () => {
  expect(impactOfPruning(graph, manifest, SHELL)).toEqual([]);
});

// ── flattenManifest: extends resolution (pure, no graph needed) ──────────────

test("flattenManifest unions an extended pack's contributors into the host", () => {
  const pack: CompositionManifest = {
    name: "self-improvement",
    entryPoints: [],
    selectedContributors: [
      asPluginId("review"),
      asPluginId("screenshot.draw-on-app"),
    ],
    extends: [],
  };
  const profile: CompositionManifest = {
    name: "full",
    entryPoints: [AGENT_MANAGER],
    selectedContributors: [asPluginId("ui.theme-toggle")],
    extends: ["self-improvement"],
  };

  const flat = flattenManifest(profile, [pack, profile]);
  expect([...flat.selectedContributors].map(String).sort()).toEqual(
    ["review", "screenshot.draw-on-app", "ui.theme-toggle"].sort(),
  );
  expect(flat.entryPoints).toEqual([AGENT_MANAGER]);
  // Always cleared after folding so downstream resolution never re-walks extends.
  expect(flat.extends).toEqual([]);
});

test("flattenManifest is diamond/cycle-safe and dedupes", () => {
  // a → b, a → c, b → c (diamond); plus c → a (cycle). All terminate, c folds once.
  const a: CompositionManifest = {
    name: "a",
    entryPoints: [asPluginId("apps.home")],
    selectedContributors: [asPluginId("ui.theme-toggle")],
    extends: ["b", "c"],
  };
  const b: CompositionManifest = {
    name: "b",
    entryPoints: [],
    selectedContributors: [asPluginId("review")],
    extends: ["c"],
  };
  const c: CompositionManifest = {
    name: "c",
    entryPoints: [],
    selectedContributors: [asPluginId("review"), asPluginId("reports.crash")],
    extends: ["a"],
  };

  const flat = flattenManifest(a, [a, b, c]);
  expect([...flat.selectedContributors].map(String).sort()).toEqual(
    ["reports.crash", "review", "ui.theme-toggle"].sort(),
  );
  expect([...flat.entryPoints].map(String)).toEqual(["apps.home"]);
});

test("flattenManifest ignores unknown extends references inertly", () => {
  const m: CompositionManifest = {
    name: "x",
    entryPoints: [asPluginId("apps.home")],
    selectedContributors: [asPluginId("ui.theme-toggle")],
    extends: ["does-not-exist"],
  };
  const flat = flattenManifest(m, [m]);
  expect([...flat.selectedContributors].map(String)).toEqual([
    "ui.theme-toggle",
  ]);
});

// ── removalClosure: reverse + subtree fixpoint (direction is load-bearing) ────

/**
 * Build a minimal synthetic EdgeGraph from explicit hard edges + a containment map.
 * Only the maps removalClosure reads (`hardReverse`, `subtree`) are load-bearing;
 * the rest are seeded empty so the shape matches the real EdgeGraph by construction.
 */
function syntheticGraph(
  nodes: string[],
  hardEdges: [from: string, to: string][],
  subtree: Record<string, string[]>,
): EdgeGraph {
  const ids = nodes.map(asPluginId);
  const empty = () =>
    new Map(ids.map((id) => [id, [] as ReturnType<typeof asPluginId>[]]));
  const hardForward = empty();
  const hardReverse = empty();
  const subtreeMap = empty();
  for (const [from, to] of hardEdges) {
    hardForward.get(asPluginId(from))!.push(asPluginId(to));
    hardReverse.get(asPluginId(to))!.push(asPluginId(from));
  }
  for (const [parent, kids] of Object.entries(subtree)) {
    subtreeMap.set(asPluginId(parent), kids.map(asPluginId));
  }
  return {
    hardForward,
    hardReverse,
    softForward: empty(),
    softReverse: empty(),
    subtree: subtreeMap,
    edges: hardEdges.map(([from, to]) => ({
      from: asPluginId(from),
      to: asPluginId(to),
      kind: "hard" as const,
    })),
  };
}

test("removalClosure: pulls in transitive importers + descendants, leaves dependencies and unrelated nodes untouched", () => {
  // Import edge A → B means "A imports B" (so A breaks if B is disabled).
  //   dep      → seed  (seed imports dep — dep is a DEPENDENCY, must NOT be disabled)
  //   importer → seed  (importer imports seed — must be disabled)
  //   far      → importer (transitive importer — must be disabled)
  //   unrelated stands alone.
  // seed also has a child (subtree) that must be disabled.
  const graph = syntheticGraph(
    ["seed", "seed.child", "dep", "importer", "far", "unrelated"],
    [
      ["seed", "dep"], // seed imports dep
      ["importer", "seed"], // importer imports seed
      ["far", "importer"], // far imports importer
    ],
    { seed: ["seed.child"] },
  );

  const closure = removalClosure([asPluginId("seed")], graph);

  // 1. Transitive importers + descendants are pulled in.
  expect(closure.has(asPluginId("seed"))).toBe(true);
  expect(closure.has(asPluginId("seed.child"))).toBe(true); // descendant
  expect(closure.has(asPluginId("importer"))).toBe(true); // direct importer
  expect(closure.has(asPluginId("far"))).toBe(true); // transitive importer

  // 2. A pure DEPENDENCY of the seed is NOT disabled — proves the reverse direction
  //    (we walk hardReverse, not hardForward).
  expect(closure.has(asPluginId("dep"))).toBe(false);

  // 3. An unrelated plugin is untouched.
  expect(closure.has(asPluginId("unrelated"))).toBe(false);

  // Exactly the expected set, nothing more.
  expect([...closure].map(String).sort()).toEqual(
    ["far", "importer", "seed", "seed.child"].sort(),
  );
});

// ── Global exclusions: the base-exclusions row every composition inherits ──────

/** The one negative the repo ships, and the thirteen plugins it resolves to (the
 *  plugin, its two sub-plugins, and every facet's `render-diff` adapter). */
const PLUGIN_CHANGES = asPluginId("review.plugin-changes");
const BASE_ROW: CompositionManifest = {
  name: BASE_EXCLUSIONS_ID,
  entryPoints: ["!review.plugin-changes.**"],
  selectedContributors: [],
  extends: [],
};
const RENDER_DIFF_FACETS = [
  "contributions",
  "cross-refs",
  "db-schema",
  "exemptions",
  "exports",
  "registrations",
  "resources",
  "routes",
  "slots",
  "structure",
];
const EXPECTED_EXCLUDED = [
  "review.plugin-changes",
  "review.plugin-changes.api-changes",
  "review.plugin-changes.file-changes",
  ...RENDER_DIFF_FACETS.map((f) => `plugin-meta.facets.${f}.render-diff`),
];

// DIRECTION. A negative takes out what would BREAK without the removed plugin —
// its descendants and its transitive importers — never what the removed plugin
// itself depends on. Get this backwards and `!x` empties the app.
test("a negative cascades to transitive importers; a dependency of the negated branch stays", () => {
  //   root.seed        — negated
  //   root.seed.child  — descendant of the negated branch ⇒ goes
  //   root.importer    — imports root.seed                ⇒ goes
  //   root.far         — imports root.importer            ⇒ goes (transitive)
  //   root.dep         — root.seed imports IT             ⇒ STAYS (direction)
  //   root.unrelated   — untouched
  const g = syntheticGraph(
    [
      "root",
      "root.seed",
      "root.seed.child",
      "root.dep",
      "root.importer",
      "root.far",
      "root.unrelated",
    ],
    [
      ["root.seed", "root.dep"],
      ["root.importer", "root.seed"],
      ["root.far", "root.importer"],
    ],
    {
      root: [
        "root.seed",
        "root.seed.child",
        "root.dep",
        "root.importer",
        "root.far",
        "root.unrelated",
      ],
      "root.seed": ["root.seed.child"],
    },
  );
  const comp = resolveComposition(g, {
    name: "cascade",
    entryPoints: ["root.**", "!root.seed.**"],
    selectedContributors: [],
  });

  for (const gone of [
    "root.seed",
    "root.seed.child",
    "root.importer",
    "root.far",
  ]) {
    expect(comp.bundle.has(asPluginId(gone))).toBe(false);
  }
  // A DEPENDENCY of the negated branch is not implicated at all.
  expect(comp.bundle.has(asPluginId("root.dep"))).toBe(true);
  expect(comp.bundle.has(asPluginId("root.unrelated"))).toBe(true);
  // The exclusion took effect, so there is nothing to report.
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// THE INHERITANCE. The composition below does not mention `review.plugin-changes`
// and does not `extends` anything — it only seeds the facets subtree, whose
// `render-diff` adapters import the excluded plugin. It still must not bundle it:
// `flattenManifest` folds the base row into EVERY manifest.
test("the base-exclusions row is inherited with no `extends`", () => {
  const facetsOnly: CompositionManifest = {
    name: "facets-only",
    entryPoints: ["plugin-meta.facets.**"],
    selectedContributors: [],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(facetsOnly, [facetsOnly, BASE_ROW]),
  );

  expect(comp.bundle.has(PLUGIN_CHANGES)).toBe(false);
  // …and so are the nine adapters that import it — the cascade, not the pattern.
  for (const f of RENDER_DIFF_FACETS) {
    expect(
      comp.bundle.has(asPluginId(`plugin-meta.facets.${f}.render-diff`)),
    ).toBe(false);
  }
  // The rest of the facets subtree still ships.
  expect(comp.bundle.has(asPluginId("plugin-meta.facets"))).toBe(true);
  expect(comp.bundle.has(asPluginId("plugin-meta.facets.contributions"))).toBe(
    true,
  );
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// THE OPT-OUT, spelled as an entry positive. Naming the excluded plugin is a
// request for it, and a request wins over the inherited negative — including the
// cascade, which never runs.
test("naming the excluded plugin as an entry positive opts back in", () => {
  const optIn: CompositionManifest = {
    name: "facets-plus-changes",
    entryPoints: ["plugin-meta.facets.**", "review.plugin-changes"],
    selectedContributors: [],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(optIn, [optIn, BASE_ROW]),
  );

  expect(comp.bundle.has(PLUGIN_CHANGES)).toBe(true);
  expect(comp.membership.get(PLUGIN_CHANGES)).toBe("entry");
  // The adapters come back too — nothing cascaded out.
  for (const f of RENDER_DIFF_FACETS) {
    expect(
      comp.bundle.has(asPluginId(`plugin-meta.facets.${f}.render-diff`)),
    ).toBe(true);
  }
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// THE SAME OPT-OUT, spelled as a selected contributor. Both spellings are ways of
// naming the plugin, so both suppress the negative.
test("naming the excluded plugin as a selected contributor opts back in", () => {
  const optIn: CompositionManifest = {
    name: "facets-plus-changes-soft",
    entryPoints: ["plugin-meta.facets.**"],
    selectedContributors: [PLUGIN_CHANGES],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(optIn, [optIn, BASE_ROW]),
  );

  expect(comp.bundle.has(PLUGIN_CHANGES)).toBe(true);
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// NOT AN OPT-OUT. Selecting an IMPORTER of the excluded plugin is not a request
// for the excluded plugin, so the negative stands — but the protected importer
// survives the cascade and drags the plugin back through its hard closure. That
// contradiction is reported, with the import chain, rather than silently resolved
// in either direction.
test("naming an importer is NOT an opt-out: the contradiction is reported with its path", () => {
  const adapter = asPluginId("plugin-meta.facets.contributions.render-diff");
  const viaImporter: CompositionManifest = {
    name: "facets-selecting-an-adapter",
    entryPoints: ["plugin-meta.facets.**"],
    selectedContributors: [adapter],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(viaImporter, [viaImporter, BASE_ROW]),
  );

  // The importer survives, so the excluded plugin is back in the bundle…
  expect(comp.bundle.has(adapter)).toBe(true);
  expect(comp.bundle.has(PLUGIN_CHANGES)).toBe(true);

  // …and that is exactly what `unsatisfiedExclusions` exists to say.
  const targets = comp.unsatisfiedExclusions.map((u) => String(u.target));
  expect(targets).toContain(String(PLUGIN_CHANGES));

  const entry = comp.unsatisfiedExclusions.find(
    (u) => u.target === PLUGIN_CHANGES,
  )!;
  // The path is the repair instruction: it lands on the excluded plugin, and the
  // chain that put it there is contiguous.
  expect(entry.path.target).toBe(PLUGIN_CHANGES);
  const steps = entry.path.steps;
  expect(steps.length).toBeGreaterThan(0);
  expect(steps[steps.length - 1]!.to).toBe(PLUGIN_CHANGES);
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i]!.from).toBe(steps[i - 1]!.to);
  }
});

// THE MIGRATION ITSELF. `singularity` is `entryPoints: ["**"]` plus the inherited
// base row, and that must bundle exactly every plugin minus the ones the
// `singularity.disabled` flag used to remove (twelve then; the exemptions facet's
// `render-diff` adapter, which imports plugin-changes, has since made it
// thirteen). This is what makes the swap provable: the same set, from a
// declaration instead of a package.json key.
test("real-tree `singularity`: everything except the thirteen excluded plugins", () => {
  const main: CompositionManifest = {
    name: "singularity",
    entryPoints: ["**"],
    selectedContributors: [],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(main, [main, BASE_ROW]),
  );

  const allIds = [...tree.byDir.values()].map((n) => String(n.id));
  for (const id of EXPECTED_EXCLUDED) expect(allIds).toContain(id);

  const missing = allIds
    .filter((id) => !comp.bundle.has(asPluginId(id)))
    .sort();
  expect(missing).toEqual([...EXPECTED_EXCLUDED].sort());
  expect(comp.bundle.size).toBe(allIds.length - EXPECTED_EXCLUDED.length);
  expect(comp.unsatisfiedExclusions).toEqual([]);
});

// The base row flattens against itself inertly — no infinite recursion, and it is
// not made to inherit itself.
test("flattenManifest does not fold the base row into itself", () => {
  const flat = flattenManifest(BASE_ROW, [BASE_ROW]);
  expect(flat.entryPoints).toEqual(["!review.plugin-changes.**"]);
  expect(flat.extends).toEqual([]);
});

// `negatedTargets` is what the author ASSERTED must leave; the thirteen absent ids
// are what that assertion cost. Keeping them separate is what lets a reader tell
// "excluded on purpose" from "excluded because something else was".
test("negatedTargets carries the asserted targets, not the cascade", () => {
  const main: CompositionManifest = {
    name: "singularity",
    entryPoints: ["**"],
    selectedContributors: [],
    extends: [],
  };
  const comp = resolveComposition(
    graph,
    flattenManifest(main, [main, BASE_ROW]),
  );

  // The pattern's own matches: the plugin and its two sub-plugins.
  expect([...comp.negatedTargets].map(String).sort()).toEqual(
    [
      "review.plugin-changes",
      "review.plugin-changes.api-changes",
      "review.plugin-changes.file-changes",
    ].sort(),
  );
  // The nine adapters left as CASCADE — out of the bundle, not asserted.
  for (const f of RENDER_DIFF_FACETS) {
    const adapter = asPluginId(`plugin-meta.facets.${f}.render-diff`);
    expect(comp.bundle.has(adapter)).toBe(false);
    expect(comp.negatedTargets.has(adapter)).toBe(false);
  }
});

// ── Developer-only runtimes are not closure edges ─────────────────────────────
//
// The regression this pins: `classifyEdges` used to union `apiUses` across EVERY
// runtime, so an import written in a folder the deployed app never executes was a
// reason to bundle its target. The live chain was `reorder/e2e` → the shared
// Playwright harness → (its `provision/`) → `browser-fetch` → `playwright`, which
// put Chromium in every composition's backend closure and broke the website
// release's `bun build --compile` on an unresolvable `chromium-bidi` require.
//
// Asserted against the REAL tree rather than a fixture: the whole failure mode was
// an edge nobody had drawn on purpose, so the test has to see the real edges.
test("e2e / provision / cli imports are not hard closure edges", () => {
  const BROWSER_FETCH = asPluginId("infra.safe-fetch.browser-fetch");
  const E2E_HARNESS = asPluginId("framework.tooling.e2e-harness");
  const REORDER = asPluginId("reorder");
  const URL_EXTRACT = asPluginId("apps.events.sources.url-extract");
  for (const id of [BROWSER_FETCH, E2E_HARNESS, REORDER, URL_EXTRACT]) {
    expect(hasNode(id)).toBe(true);
  }

  // `reorder/e2e` really does import the harness — without this the assertion
  // below would pass for the wrong reason the day that script is deleted.
  const reorderNode = [...tree.byDir.values()].find((n) => n.id === REORDER)!;
  const reorderE2eUses = getFacet(
    reorderNode,
    crossRefsFacetDef,
  )!.apiUses.e2e.map((u) => u.plugin);
  expect(reorderE2eUses).toContain(E2E_HARNESS);

  // …and that import buys the harness no place in anyone's bundle.
  expect(graph.hardForward.get(REORDER)).not.toContain(E2E_HARNESS);
  // The harness's `provision/` import of browser-fetch, likewise.
  expect(graph.hardForward.get(E2E_HARNESS)).not.toContain(BROWSER_FETCH);

  // The consequence: Playwright is reachable ONLY from the one plugin that
  // genuinely imports it from a runtime the app runs, so it lands only in the
  // compositions that ship that plugin.
  expect(graph.hardReverse.get(BROWSER_FETCH)).toEqual([URL_EXTRACT]);
});

test("token use is a hard edge: a plugin painting with a group's var bundles the group", () => {
  // `primitives.avatar` paints `from-categorical-1-deep`/`bg-categorical-N/15`
  // and imports nothing of `ui.tokens.categorical`, whose `web/` alone
  // registers `--categorical-*` (equin.ai once shipped blank app tiles so).
  const AVATAR = asPluginId("primitives.avatar");
  const CATEGORICAL = asPluginId("ui.tokens.categorical");
  const use = getFacet(
    [...tree.byDir.values()].find((n) => n.id === AVATAR)!,
    crossRefsFacetDef,
  )!.tokenUses.find((u) => u.plugin === CATEGORICAL);
  expect(use?.group).toBe("categorical");
  expect(use?.vars).toContain("--categorical-1");
  expect(graph.hardForward.get(AVATAR)).toContain(CATEGORICAL);
  expect(graph.hardReverse.get(CATEGORICAL)).toContain(AVATAR);
  expect(
    graph.edges.find((e) => e.from === AVATAR && e.to === CATEGORICAL)?.via,
  ).toBe("token");
});

test("the website bundles the token groups it paints with, none listed by name", () => {
  // Neither group is an entry of the website or of `served-baseline`: they
  // arrive through the token edges of the plugins the site renders.
  const comp = resolveComposition(graph, {
    name: "website-probe",
    entryPoints: [asPluginId("apps.website.**")],
    selectedContributors: [],
  });
  for (const id of [
    "ui.tokens.categorical",
    "ui.tokens.chart",
    "ui.tokens.color-palette",
  ])
    expect(comp.bundle.has(asPluginId(id))).toBe(true);
});

// ── Companion contributions ───────────────────────────────────────────────────
//
// A contribution flagged `companion: true` to a slot whose owner opened it with
// `companions: true` ships wherever the owner does — a hard owner → contributor
// edge. Asserted on the real tree: these are the plugins `served-baseline` used
// to hand-list after equin.ai shipped without them (blank icons, slots ignoring
// their committed layouts).
test("a companion contribution is a hard edge from the slot's owner", () => {
  const pairs: [string, string][] = [
    ["ui.icons", "ui.icons.sprites"],
    ["ui.icons", "ui.tokens.icons"],
    ["ui.tokens.font-family", "ui.tokens.font-family.google-fonts"],
    ["primitives.slot-render", "reorder.slot-middleware"],
    ["primitives.slot-render", "primitives.error-boundary"],
    ["reorder.node-types", "reorder.node-types.spacer"],
  ];
  for (const [owner, companion] of pairs) {
    const from = asPluginId(owner);
    const to = asPluginId(companion);
    expect(graph.hardForward.get(from)).toContain(to);
    expect(graph.hardReverse.get(to)).toContain(from);
    const via = graph.edges.find(
      (e) => e.from === from && e.to === to && e.kind === "hard",
    )?.via;
    expect(via).toBe("companion");
  }
});

test("an ordinary contribution to a companion slot stays an opt-in option", () => {
  // The element picker's lineage marker contributes to slot-render's middleware
  // slots WITHOUT the flag: it is a soft option, never pulled in by slot-render.
  const SLOT_RENDER = asPluginId("primitives.slot-render");
  const PICKER = asPluginId("primitives.ui-context.element-picker");
  expect(graph.hardForward.get(SLOT_RENDER)).not.toContain(PICKER);
  expect(graph.softForward.get(PICKER)).toContain(SLOT_RENDER);
});

test("the website bundles its runtime companions, none listed by name", () => {
  const comp = resolveComposition(graph, {
    name: "website-probe",
    entryPoints: [asPluginId("apps.website.**")],
    selectedContributors: [],
  });
  for (const id of [
    "ui.icons.sprites",
    "ui.tokens.icons",
    "reorder",
    "reorder.slot-middleware",
    "reorder.node-types.spacer",
  ])
    expect(comp.bundle.has(asPluginId(id))).toBe(true);
});
