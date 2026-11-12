import { expect, test } from "bun:test";
import {
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { resolveComposition } from "./resolve-composition";
import type { CompositionManifest, Edge, EdgeGraph } from "./types";

// The /demo incident, in miniature:
//
//   conv            (umbrella: `conv.**` asks for its renderers)
//   conv.read       ─import→ chip
//   conv.bash       (imports nothing negated)
//   chip            ─import→ pane
//   pane            ─import→ explorer.browser
//   explorer        (umbrella: `!explorer.**` negates it)
//   explorer.browser
//   apps            (umbrella over explorer)
const ids = [
  "conv",
  "conv.read",
  "conv.bash",
  "chip",
  "pane",
  "explorer",
  "explorer.browser",
  "apps",
] as const;
const imports: [string, string][] = [
  ["conv.read", "chip"],
  ["chip", "pane"],
  ["pane", "explorer.browser"],
];
const children: Record<string, string[]> = {
  conv: ["conv.read", "conv.bash"],
  explorer: ["explorer.browser"],
  apps: ["explorer", "explorer.browser"],
};

function graph(): EdgeGraph {
  const empty = () =>
    new Map<PluginId, PluginId[]>(ids.map((i) => [asPluginId(i), []]));
  const hardForward = empty();
  const hardReverse = empty();
  const subtree = empty();
  const edges: Edge[] = [];
  for (const [from, to] of imports) {
    hardForward.get(asPluginId(from))!.push(asPluginId(to));
    hardReverse.get(asPluginId(to))!.push(asPluginId(from));
    edges.push({
      from: asPluginId(from),
      to: asPluginId(to),
      kind: "hard",
      via: "import",
      runtimes: ["web"],
    });
  }
  for (const [parent, kids] of Object.entries(children))
    subtree.set(asPluginId(parent), kids.map(asPluginId));
  return {
    hardForward,
    hardReverse,
    softForward: empty(),
    softReverse: empty(),
    subtree,
    edges,
    rules: [],
    hostProviders: new Map(),
    hostRoots: new Map(),
  };
}

const manifest = (entryPoints: string[]): CompositionManifest => ({
  name: "probe",
  hosts: ["browser"],
  entryPoints,
  selectedContributors: [],
});

const losses = (entryPoints: string[]) =>
  resolveComposition(graph(), manifest(entryPoints)).cascadeLosses.map((l) => ({
    lost: String(l.lost),
    target: String(l.target),
    chain: l.chain.map((h) => `${h.from} -${h.via}-> ${h.to}`),
  }));

test("a negative that cascades into an asked-for plugin reports it, with the chain", () => {
  expect(losses(["conv.**", "!explorer.**"])).toEqual([
    {
      lost: "conv.read",
      target: "explorer.browser",
      chain: [
        "conv.read -import-> chip",
        "chip -import-> pane",
        "pane -import-> explorer.browser",
      ],
    },
  ]);
});

test("a cascade through plugins nobody asked for is no loss", () => {
  // `chip` and `pane` leave too, but no positive pattern seeded them.
  expect(losses(["conv.bash", "!explorer.**"])).toEqual([]);
});

test("writing the loss down as its own negative acknowledges it", () => {
  expect(losses(["conv.**", "!explorer.**", "!conv.read"])).toEqual([]);
});

test("naming the plugin keeps it: no cascade, so no loss", () => {
  const comp = resolveComposition(
    graph(),
    manifest(["conv.**", "!explorer.**", "conv.read"]),
  );
  expect(comp.cascadeLosses).toEqual([]);
  // …and the exclusion it contradicts is reported instead.
  expect(comp.unsatisfiedExclusions.map((u) => String(u.target))).toEqual([
    "explorer.browser",
  ]);
});

test("a plugin the negative matches itself is what it names, not a loss", () => {
  expect(losses(["explorer.**", "pane", "!explorer.browser"])).toEqual([]);
});

test("a descendant of a negated plugin is no loss", () => {
  // `!explorer` (exact) takes `explorer.browser`, which `apps.**` asked for:
  // a child leaves with the parent the negative names.
  expect(losses(["apps.**", "!explorer"])).toEqual([]);
});

test("a root `**` asks for nothing in particular", () => {
  expect(losses(["**", "!explorer.**"])).toEqual([]);
});
