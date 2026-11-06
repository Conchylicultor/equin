/**
 * The browser-host graph derivation: over the real repo it reproduces the
 * committed demo graph (and takes no negated plugin back but the providers);
 * over fixtures, the rule's failures — a non-portable barrel in the graph's
 * closure (named with its import chain), a service with zero or two
 * providers — throw, and a negated plugin providing nothing the graph declares
 * stays out.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  asFsPath,
  asPluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  deriveBrowserHostGraph,
  discoverBrowserHosts,
  inferBrowserHostGraph,
  renderBrowserHostScope,
  resolveHostGraph,
  type HostClosure,
  type HostGraphInputs,
} from "./browser-host-gen";
import { buildRegistryGenContext } from "./plugin-registry-gen";
import { codegenPassOver } from "./codegen-pass";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";

setDefaultTimeout(300_000);

const DEMO = "apps/plugins/website/plugins/demos/plugins/workspace";

describe("deriveBrowserHostGraph over the repo", () => {
  test("reproduces the committed demo graph, one provider per service", async () => {
    const root = await getWorktreeRoot();
    const ctx = await buildRegistryGenContext(
      codegenPassOver(await loadRepoSnapshot(root)),
    );
    const host = discoverBrowserHosts(await ctx.repo()).find(
      (h) => h.pluginPath === DEMO,
    );
    expect(host).toBeDefined();
    const graph = await deriveBrowserHostGraph(ctx, host!);
    expect(graph.composition).toBe("agent-manager-demo");
    // One derivation per ctx: every caller holding it shares the memo.
    expect(deriveBrowserHostGraph(ctx, host!)).toBe(
      deriveBrowserHostGraph(ctx, host!),
    );
    expect(await inferBrowserHostGraph(ctx, host!)).toMatchObject({
      members: graph.members,
      providers: graph.providers,
    });

    const committed = readFileSync(join(root, host!.generated), "utf8");
    const entries = [...committed.matchAll(/\{ pluginPath: "([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(graph.members).toEqual(entries);

    // Every provider is a member, and the negated plugins that provide
    // nothing (review/plugin-changes) are not taken back.
    for (const p of Object.values(graph.providers)) {
      expect(graph.members).toContain(p);
    }
    expect(graph.providers["database.migration-source"]).toBe(
      "database/plugins/migrations/plugins/bundled-source",
    );
    expect(
      graph.members.filter((p) =>
        p.startsWith("review/plugins/plugin-changes"),
      ),
    ).toEqual([]);

    // The page side: the composition's home, its web plugins (bundle ∩ web
    // barrels, by dot id, sorted) and what it leaves out.
    // The app gallery, as on main (the demo still opens on the Agent Manager).
    expect(graph.home).toBe("home");
    expect(graph.webPlugins).toEqual([...graph.webPlugins].sort());
    expect(graph.webPlugins).toContain(asPluginId("apps.agent-manager.shell"));
    const repo = await ctx.repo();
    for (const id of graph.webPlugins) {
      expect(repo.has(`plugins/${asFsPath(id)}/web/index.ts`)).toBe(true);
    }
    // A bundled plugin without a web barrel is not a web plugin.
    expect(graph.webPlugins).not.toContain(asPluginId("database"));
    // `available` is the out-of-bundle frontier: disjoint from the web set,
    // sorted, and non-empty (review.code-review soft-contributes to the bundled
    // review pane but is not shipped).
    expect(graph.available).toEqual([...graph.available].sort());
    for (const id of graph.available) {
      expect(graph.webPlugins).not.toContain(id);
    }
    expect(graph.available).toContain(asPluginId("review.code-review"));

    // The page's scope file names exactly the web plugins, the home and the
    // host's own start module.
    const scope = renderBrowserHostScope(host!, graph);
    expect(host!.scopeGenerated).toBe(
      `plugins/${DEMO}/core/browser-host.generated.ts`,
    );
    const listed = [...scope.matchAll(/^ {4}"([^"]+)",$/gm)].map((m) => m[1]!);
    expect(listed).toEqual(graph.webPlugins);
    expect(scope).toContain('  id: "agent-manager-demo",');
    expect(scope).toContain('  home: "home",');
    expect(scope).toContain(`import("@browser-host/${DEMO}")`);
    expect(scope).toContain("} satisfies DemoHost;");
  });
});

describe("deriveBrowserHostGraph over its own stale output", () => {
  test("a graph file naming a removed server barrel is measured as its empty render", async () => {
    // A server barrel moved or deleted leaves the committed graph file naming
    // it; the derivation that regenerates the file must not trip on it.
    const root = await getWorktreeRoot();
    const snapshot = await loadRepoSnapshot(root);
    const host = discoverBrowserHosts(snapshot).find(
      (h) => h.pluginPath === DEMO,
    )!;
    const committed = (await snapshot.read(host.generated))!;
    const stale = committed.replace(
      "];\n",
      `  { pluginPath: "gone", id: "gone", loader: () => import("@plugins/gone/server"), dependsOn: [], core: null },\n];\n`,
    );
    expect(stale).not.toBe(committed);
    const staleSnapshot: RepoSnapshot = {
      root: snapshot.root,
      all: () => snapshot.all(),
      has: (p) => snapshot.has(p),
      under: (d) => snapshot.under(d),
      glob: (g) => snapshot.glob(g),
      read: async (p) => (p === host.generated ? stale : snapshot.read(p)),
      blobOf: (p) =>
        p === host.generated ? "stale-graph-blob" : snapshot.blobOf(p),
    };
    const ctx = await buildRegistryGenContext(codegenPassOver(staleSnapshot));
    const graph = await inferBrowserHostGraph(ctx, host);
    expect(graph.members).not.toContain("gone");
    expect(graph.members.length).toBeGreaterThan(0);
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

// A fixture module under a made-up plugin (`plugins/<plugin>/<rest>`).
const at = (plugin: string, rest: string): string =>
  `plugins/${plugin}/${rest}`;
const barrel = (p: string): string => at(p, "server/index.ts");
const portable = (provides = ""): string =>
  `export default { contributions: [${provides}] };`;
const ENTRY = at("host", "bin/browser-host.ts");

/**
 * A fixture repo: files by path, each module's static closure, and the
 * barrels that are NOT portable, each with what its closure needs (every
 * other barrel is portable — portability is injected, as derived).
 */
function inputs(
  files: Record<string, string>,
  closures: Record<string, string[]>,
  over: Partial<HostGraphInputs> = {},
  nonPortable: Record<string, string> = {},
): HostGraphInputs {
  return {
    label: "fixture",
    entry: ENTRY,
    bundleBarrels: [],
    candidateBarrels: [],
    read: async (path) => files[path] ?? null,
    portability: {
      isPortable: (b) => !(b in nonPortable),
      offenders: (b) => [{ module: b, needs: [nonPortable[b]!], chain: [b] }],
    },
    closure: async (entries): Promise<HostClosure> => {
      const of = (e: string): string[] => [e, ...(closures[e] ?? [])];
      return {
        modules: new Set(entries.flatMap(of)),
        importChain: (m) => {
          const entry = entries.find((e) => of(e).includes(m))!;
          return m === entry ? [entry] : [entry, m];
        },
      };
    },
    ...over,
  };
}

const SERVICE_MODULE = at("db", "server/internal/driver.ts");
const SERVICE = `export const Driver = defineHostService<DriverImpl>("db.driver");`;

describe("resolveHostGraph", () => {
  test("adds the one provider of a declared service, and no other negated plugin", async () => {
    const graph = await resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("db")]: portable(),
          [SERVICE_MODULE]: SERVICE,
          [barrel("db/plugins/memory")]: portable("Driver.provide(memory)"),
          [barrel("review")]: portable("Unrelated.provide(x)"),
        },
        { [barrel("db")]: [SERVICE_MODULE] },
        {
          bundleBarrels: [barrel("db")],
          candidateBarrels: [barrel("db/plugins/memory"), barrel("review")],
        },
      ),
    );
    expect(graph.members).toEqual(["db", "db/plugins/memory"]);
    expect(graph.providers).toEqual({ "db.driver": "db/plugins/memory" });
    // One closure for the entry, one per round for the unreached members: the
    // bundle's, then the provider the fixpoint added.
    expect(graph.closures).toBe(3);
  });

  test("the entry's portable imports are roots", async () => {
    const graph = await resolveHostGraph(
      inputs(
        { [ENTRY]: "", [barrel("seeded")]: portable() },
        { [ENTRY]: [barrel("seeded")] },
      ),
    );
    expect(graph.members).toEqual(["seeded"]);
  });

  test("a non-portable barrel in the closure throws, naming the chain", async () => {
    const run = resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("app")]: portable(),
          [barrel("disk")]: "export default { contributions: [] };",
        },
        { [barrel("app")]: [barrel("disk")] },
        { bundleBarrels: [barrel("app"), barrel("disk")] },
        { [barrel("disk")]: "node:fs" },
      ),
    );
    expect(run).rejects.toThrow(
      `the graph loads ${barrel("disk")}, which is not in it (not portable: ${barrel("disk")} needs node:fs)\n      via ${barrel("app")} → ${barrel("disk")}`,
    );
  });

  test("a declared service with no provider throws", async () => {
    const run = resolveHostGraph(
      inputs(
        { [ENTRY]: "", [barrel("db")]: portable(), [SERVICE_MODULE]: SERVICE },
        { [barrel("db")]: [SERVICE_MODULE] },
        { bundleBarrels: [barrel("db")] },
      ),
    );
    expect(run).rejects.toThrow(
      `host service "db.driver" (${SERVICE_MODULE}) has no provider`,
    );
  });

  test("a declared service with two providers throws, naming both", async () => {
    const run = resolveHostGraph(
      inputs(
        {
          [ENTRY]: "",
          [barrel("db")]: portable(),
          [SERVICE_MODULE]: SERVICE,
          [barrel("db/plugins/a")]: portable("Driver.provide(a)"),
          [barrel("db/plugins/b")]: portable("Driver.provide(b)"),
        },
        { [barrel("db")]: [SERVICE_MODULE] },
        {
          bundleBarrels: [barrel("db")],
          candidateBarrels: [barrel("db/plugins/a"), barrel("db/plugins/b")],
        },
      ),
    );
    expect(run).rejects.toThrow(
      `host service "db.driver" has 2 providers: db/plugins/a, db/plugins/b`,
    );
  });
});
