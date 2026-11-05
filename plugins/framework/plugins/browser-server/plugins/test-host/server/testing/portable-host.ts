import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declareMemoryHostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core/testing";
import type {
  ServerPluginDefinition,
  ServerRegistryEntry,
} from "@plugins/framework/plugins/server-core/core";
import {
  declaredHostServiceIds,
  hostServicesProvidedBy,
  isHostService,
  serverEntries,
  serverEntryFor,
} from "@plugins/framework/plugins/server-core/core/testing";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { serverPortabilityOf } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import { providedServiceNames } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

type Entry = ServerRegistryEntry;

/**
 * The registry entries reached from `roots` along the `dependsOn` edges
 * `follow` keeps. A root or edge target not in the registry fails loudly.
 */
function closureOf(
  roots: readonly string[],
  follow: (path: string) => boolean,
): Set<string> {
  const entries = new Map(serverEntries.map((e) => [e.pluginPath, e]));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const path = stack.pop()!;
    if (seen.has(path)) continue;
    const entry = entries.get(path);
    if (entry === undefined) {
      throw new Error(`${path} is not in the server registry`);
    }
    seen.add(path);
    stack.push(...entry.dependsOn.filter(follow));
  }
  return seen;
}

/**
 * The `dependsOn` closure of `roots` in the app's server registry, every edge
 * followed — the graph `bootPluginGraph`'s `exec` mode boots (it loads the
 * desktop's edges as they are). A root not in the registry fails loudly.
 */
export function registryClosureOf(roots: readonly string[]): Entry[] {
  const seen = closureOf(roots, () => true);
  return serverEntries.filter((e) => seen.has(e.pluginPath));
}

/**
 * The portable `dependsOn` closure of `roots` in the app's server registry:
 * only edges to portable server barrels (derived from their closures,
 * `serverPortabilityOf`) are followed, and each entry's edges are kept to the
 * graph — the graph a browser host boots (`browser-host-gen` does the same;
 * its build guard proves the portable code loads no other barrel). A root
 * that is not portable fails loudly.
 */
export async function portableClosureOf(
  roots: readonly string[],
): Promise<Entry[]> {
  const portability = await serverPortabilityOf(await loadRepoFiles(REPO_ROOT));
  const isPortable = (path: string) =>
    portability.isPortable(`plugins/${path}/server/index.ts`);
  for (const root of roots) {
    if (!isPortable(root)) throw new Error(`${root} is not portable`);
  }
  const seen = closureOf(roots, isPortable);
  return serverEntries
    .filter((e) => seen.has(e.pluginPath))
    .map((e) => ({ ...e, dependsOn: e.dependsOn.filter((d) => seen.has(d)) }));
}

/**
 * The host providers' candidates: every plugin whose `server/index.ts` calls
 * `<Service>.provide(…)` — which no composition bundles (the closure engine's
 * `EdgeGraph.hostProviders`, so none is in the app's registry) — with its
 * source. Read, never loaded: loading one evaluates its service owner's
 * modules, whose declarations the boot would then demand.
 */
function providerCandidates(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  // Plugin folders only (`<p>/plugins/<child>/…`), never a package's own tree.
  const visit = (path: string): void => {
    const barrel = join(PLUGINS_DIR, path, "server", "index.ts");
    if (existsSync(barrel)) {
      const source = readFileSync(barrel, "utf8");
      if (providedServiceNames(source).length > 0) out.push({ path, source });
    }
    const children = join(PLUGINS_DIR, path, "plugins");
    if (!existsSync(children)) return;
    for (const child of readdirSync(children, { withFileTypes: true })) {
      if (child.isDirectory()) visit(`${path}/plugins/${child.name}`);
    }
  };
  for (const top of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (top.isDirectory()) visit(top.name);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const HARNESS = "framework/plugins/browser-server/plugins/test-host";

/**
 * A harness-owned entry contributing `contributions`, after `dependsOn`. Its
 * owner's modules are imported by `contributions` itself, never statically
 * here: importing one declares its host services, which a graph without that
 * owner would then have to provide.
 */
function harnessEntry(
  name: string,
  dependsOn: string[],
  contributions: () => Promise<
    NonNullable<ServerPluginDefinition["contributions"]>
  >,
): Entry {
  return {
    pluginPath: `${HARNESS}/${name}`,
    id: `${HARNESS.split("/plugins/").join(".")}.${name}`,
    loader: async () => ({
      default: {
        contributions: await contributions(),
      } satisfies ServerPluginDefinition,
    }),
    dependsOn,
    core: null,
  };
}

const MIGRATIONS = "database/plugins/migrations";
const CONFIG = "config_v2";

/**
 * What the bundled providers inline with `import.meta.glob` (which Bun has
 * not), read off disk by the harness instead — the committed migration
 * history and the committed config layer — each only when the graph holds the
 * service's owner. Provided before the providers are chosen, so the bundled
 * candidates are never picked.
 */
function committedFromDisk(members: ReadonlySet<string>): Entry[] {
  const out: Entry[] = [];
  if (members.has(MIGRATIONS)) {
    out.push(
      harnessEntry("committed-migrations", [MIGRATIONS], async () => [
        (await import("./committed-migrations")).committedMigrations(),
      ]),
    );
  }
  if (members.has(CONFIG)) {
    out.push(
      harnessEntry("committed-config", [CONFIG], async () => [
        (await import("./committed-config")).committedConfig(),
      ]),
    );
  }
  return out;
}

type LoadedBarrel = Record<string, unknown> & {
  default: ServerPluginDefinition;
};

/**
 * `graph` as a host without the computer boots it, for a suite booting a
 * slice of the registry (`bootPluginGraph` / `bootBrowserHost`) in its own
 * process:
 *
 * - the committed migrations and config, read off disk (`committedFromDisk`);
 * - one host provider per host service the graph's modules declare, to a
 *   fixpoint (a provider's own modules may declare another), chosen the way
 *   codegen picks a browser host's (`browser-host-gen.ts`): the candidate
 *   whose barrel spells `<Service>.provide(` — the service named by the
 *   binding a loaded barrel exports it under. Derived, never hand-listed: a
 *   hand-kept list goes stale each time the closure reaches a new service. A
 *   service with no candidate, or two, fails, naming them;
 * - in-memory host storage, declared (`declareMemoryHostStorage`) — where the
 *   memory providers keep their state, as a host's entry point declares it.
 *
 * Modules load one at a time here, so no barrel races another.
 */
export async function withPortableHost(graph: Entry[]): Promise<Entry[]> {
  declareMemoryHostStorage();
  const entries = [
    ...graph,
    ...committedFromDisk(new Set(graph.map((e) => e.pluginPath))),
  ];
  const candidates = providerCandidates();
  const provided = new Set<string>();
  const bindingOf = new Map<string, string>();
  const load = async (entry: Entry): Promise<void> => {
    const mod = (await entry.loader()) as LoadedBarrel;
    for (const id of hostServicesProvidedBy(mod.default.contributions ?? [])) {
      provided.add(id);
    }
    for (const [name, value] of Object.entries(mod)) {
      if (isHostService(value)) bindingOf.set(value.id, name);
    }
  };
  for (const e of entries) await load(e);
  for (;;) {
    const missing = declaredHostServiceIds().filter((id) => !provided.has(id));
    if (missing.length === 0) return entries;
    const members = entries.map((e) => e.pluginPath);
    for (const id of missing) {
      if (provided.has(id)) continue; // a provider chosen above serves it too
      const binding = bindingOf.get(id);
      if (binding === undefined) {
        throw new Error(
          `host service "${id}" is declared but no loaded server barrel exports it, so its provider cannot be named`,
        );
      }
      const spelled = new RegExp(`\\b${binding}\\.provide\\(`);
      const by = candidates.filter((c) => spelled.test(c.source));
      if (by.length !== 1) {
        throw new Error(
          `host service "${id}" (${binding}) has ${by.length} host providers: ${by.map((c) => c.path).join(", ") || "none"}`,
        );
      }
      // Loaded after everything chosen so far: its import of the service's
      // owner never races that owner's load wave.
      const provider = serverEntryFor(by[0]!.path, members);
      entries.push(provider);
      await load(provider);
    }
  }
}
