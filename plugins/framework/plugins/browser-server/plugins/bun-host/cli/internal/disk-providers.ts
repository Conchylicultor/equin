// A browser host's graph as Bun boots it. The worker bundles two providers
// whose data is text inlined by vite's `import.meta.glob`, which Bun cannot
// evaluate: the migration history (`migrations/bundled-source`) and the
// committed config layer (`config_v2/bundled-layer`). Here each is swapped for
// an entry providing the same service from the same files read off disk, so
// a Bun process (the website's crawl snapshot take, the workspace demo's
// snapshot and boot test) boots the graph the worker boots, nothing else
// changed. A build that addresses the take by its inputs covers these files
// through the bundled providers' own glob roots.

import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import type {
  ServerContribution,
  ServerPluginDefinition,
  ServerRegistryEntry,
} from "@plugins/framework/plugins/server-core/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import {
  committedDocument,
  readCommittedFilesSync,
} from "@plugins/config_v2/core";
import { ConfigGitLayer } from "@plugins/config_v2/server";

const MIGRATIONS_DATA = `${PLUGINS_DIR}/database/plugins/migrations/data`;

/** The migration history off disk: what the bundled source inlines. */
export function diskMigrationList() {
  return migrationsFrom(
    readdirSync(MIGRATIONS_DATA)
      .filter(isMigrationFileName)
      .map((file) => ({
        file,
        sqlText: readFileSync(`${MIGRATIONS_DATA}/${file}`, "utf8"),
      })),
  );
}

const OWN = "framework/plugins/browser-server/plugins/bun-host";

function diskEntry(
  name: string,
  dependsOn: string,
  contribution: () => ServerContribution,
): ServerRegistryEntry {
  return {
    pluginPath: `${OWN}/${name}`,
    id: `${OWN.split("/plugins/").join(".")}.${name}`,
    loader: async () => ({
      default: {
        contributions: [contribution()],
      } satisfies ServerPluginDefinition,
    }),
    dependsOn: [dependsOn],
    core: null,
  };
}

/** Host service → the disk-backed entry standing in for its bundled provider. */
const SWAPS: Readonly<Record<string, ServerRegistryEntry>> = {
  [MigrationSource.id]: diskEntry(
    "disk-migrations",
    "database/plugins/migrations",
    () => MigrationSource.provide({ list: diskMigrationList }),
  ),
  [ConfigGitLayer.id]: diskEntry("disk-config", "config_v2", () => {
    const committedFiles = readCommittedFilesSync(`${REPO_ROOT}/config`, {
      existsSync,
      readFileSync: (path) => readFileSync(path, "utf8"),
      readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
    });
    // Unwatched: the committed layer does not move under one boot.
    return ConfigGitLayer.provide({
      document: (storePath) =>
        Promise.resolve(committedDocument(storePath, committedFiles)),
      watch: () => Promise.resolve(() => {}),
    });
  }),
};

/**
 * A browser host's `entries` (its generated graph) with each bundled-text
 * provider its `providers` map names (host service → provider plugin path)
 * swapped for the disk one. A swapped provider must be exactly one entry of
 * the graph and provide that one service only — a swap dropping another
 * service with it, or naming no entry, fails loudly.
 */
export function withDiskProviders(
  entries: readonly ServerRegistryEntry[],
  providers: Readonly<Record<string, string>>,
): ServerRegistryEntry[] {
  const services = Object.keys(SWAPS).filter((s) => providers[s] !== undefined);
  const swapped = new Set(services.map((s) => providers[s]!));
  for (const [service, provider] of Object.entries(providers)) {
    if (swapped.has(provider) && !(service in SWAPS))
      throw new Error(
        `[bun host] ${provider} provides ${service} too: swapping it would drop that service`,
      );
  }
  const graph = entries.filter((e) => !swapped.has(e.pluginPath));
  if (graph.length !== entries.length - swapped.size)
    throw new Error(
      `[bun host] the swapped providers (${[...swapped].join(", ")}) are not each one entry of the graph`,
    );
  return [...graph, ...services.map((s) => SWAPS[s]!)];
}
