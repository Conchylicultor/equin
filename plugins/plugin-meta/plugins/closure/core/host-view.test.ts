import { expect, test } from "bun:test";
import {
  asPluginId,
  type HostId,
  type PluginId,
  type RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import { graphForHosts } from "./host-view";
import { expandEntrySeeds, resolveComposition } from "./resolve-composition";
import { explainInclusion } from "./explain";
import type { CompositionManifest, Edge, EdgeGraph } from "./types";

// app ─web→ ui        (a page import: every host)
// app ─machine→ warmup (Sonata's MIDI folders → infra/warmup: desktop only)
// app ─central→ hub    (central: desktop only)
// app ─e2e→ harness    (a developer surface: no host)
// warmup ─server→ jobs (what warmup itself needs, reached only through it)
const ids = ["app", "ui", "warmup", "hub", "harness", "jobs"] as const;
const edges: [string, string, RuntimeFolder][] = [
  ["app", "ui", "web"],
  ["app", "warmup", "machine"],
  ["app", "hub", "central"],
  ["app", "harness", "e2e"],
  ["warmup", "jobs", "server"],
];

function graph(): EdgeGraph {
  const empty = () =>
    new Map<PluginId, PluginId[]>(ids.map((i) => [asPluginId(i), []]));
  const hardForward = empty();
  const hardReverse = empty();
  const list: Edge[] = [];
  for (const [from, to, rt] of edges) {
    // The classifier never tags an edge with a folder no host runs; keep the
    // fixture honest to that (the e2e import is no edge at all).
    if (rt === "e2e") continue;
    hardForward.get(asPluginId(from))!.push(asPluginId(to));
    hardReverse.get(asPluginId(to))!.push(asPluginId(from));
    list.push({
      from: asPluginId(from),
      to: asPluginId(to),
      kind: "hard",
      via: "import",
      runtimes: [rt],
    });
  }
  return {
    hardForward,
    hardReverse,
    softForward: empty(),
    softReverse: empty(),
    subtree: empty(),
    edges: list,
    rules: [],
    hostProviders: new Map(),
  };
}

const manifest = (
  hosts: HostId[],
  entryPoints = ["app"],
): CompositionManifest => ({
  name: "probe",
  hosts,
  entryPoints,
  selectedContributors: [],
});

const bundleOf = (g: EdgeGraph, m: CompositionManifest, host?: HostId) =>
  [...resolveComposition(g, m, host).bundle].map(String).sort();

test("desktop follows machine/ and central/ imports", () => {
  expect(bundleOf(graph(), manifest(["desktop"]))).toEqual([
    "app",
    "hub",
    "jobs",
    "ui",
    "warmup",
  ]);
});

test("browser ignores a machine/-only edge, and everything only it reached", () => {
  expect(bundleOf(graph(), manifest(["browser"]))).toEqual(["app", "ui"]);
});

test("a composition declared for both hosts bundles the union", () => {
  const g = graph();
  const both = bundleOf(g, manifest(["browser", "desktop"]));
  const union = [
    ...new Set([
      ...bundleOf(g, manifest(["desktop"])),
      ...bundleOf(g, manifest(["browser"])),
    ]),
  ].sort();
  expect(both).toEqual(union);
});

test("an explicit host resolves the composition as that host sees it", () => {
  const g = graph();
  const m = manifest(["browser", "desktop"]);
  expect(bundleOf(g, m, "browser")).toEqual(["app", "ui"]);
  expect(bundleOf(g, m, "desktop")).toContain("warmup");
});

test("a negative cascades only through the edges the host follows", () => {
  // `**` minus warmup: on the desktop `app` imports warmup (from machine/), so
  // it leaves with it; in the browser it does not, so it stays.
  const g = graph();
  const seeds = (hosts: HostId[]) =>
    [...expandEntrySeeds(manifest(hosts, ["**", "!warmup"]), g).seeds]
      .map(String)
      .sort();
  expect(seeds(["browser"])).toEqual(["app", "harness", "hub", "jobs", "ui"]);
  expect(seeds(["desktop"])).toEqual(["harness", "hub", "jobs", "ui"]);
  // A NAMED importer survives on the desktop and re-adds warmup, which the
  // postcondition reports; in the browser there is nothing to report.
  const named = (hosts: HostId[]) =>
    resolveComposition(
      g,
      manifest(hosts, ["app", "!warmup"]),
    ).unsatisfiedExclusions.map((u) => String(u.target));
  expect(named(["desktop"])).toEqual(["warmup"]);
  expect(named(["browser"])).toEqual([]);
});

test("an inclusion path names the importing folder", () => {
  const path = explainInclusion(
    graph(),
    manifest(["desktop"]),
    asPluginId("jobs"),
  );
  expect(path?.steps.map((s) => s.edge)).toEqual([
    { via: "import", runtimes: ["machine"] },
    { via: "import", runtimes: ["server"] },
  ]);
  expect(
    explainInclusion(graph(), manifest(["browser"]), asPluginId("jobs")),
  ).toBeNull();
});

test("a view of a view is cut from the whole graph", () => {
  const g = graph();
  const browser = graphForHosts(g, ["browser"]);
  expect(graphForHosts(browser, ["desktop"])).toBe(
    graphForHosts(g, ["desktop"]),
  );
  expect(graphForHosts(g, ["desktop", "browser"])).toBe(
    graphForHosts(g, ["browser", "desktop"]),
  );
});

test("a composition declaring no host is refused", () => {
  expect(() => resolveComposition(graph(), manifest([]))).toThrow(
    /at least one host/,
  );
});
