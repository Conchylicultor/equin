// The demo's browser host as Bun boots it — the build taking its snapshot
// (`./browser-host.snapshot.ts`) and the boot test (`./browser-host.test.ts`).
//
// Bun cannot evaluate a vite `import.meta.glob`, so the two providers whose
// data is bundled text are swapped for the same data read off disk: the
// migration history (`migrations/bundled-source`) and the committed config
// layer (`config_v2/bundled-layer`). Every other entry is the graph the worker
// boots. The seed's own bundled input — the demo's prototypes and their
// thumbnails, and the user's Documents — is read off disk the same way
// (`diskDemoData`).

import {
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  isMigrationFileName,
  migrationsFrom,
  MigrationSource,
} from "@plugins/database/plugins/migrations/server";
import {
  committedDocument,
  committedFilesFromMap,
} from "@plugins/config_v2/core";
import { ConfigGitLayer } from "@plugins/config_v2/server";
import { prototypeFixtureDataOf } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import type { DemoSeedData } from "./seed";
import { hostEntries, hostProviders } from "./browser-host.generated";

const DOCUMENTS = "documents/";

/** The demo's `data/` folder off disk, as the seed reads it. */
export function diskDemoData(): DemoSeedData {
  const dir = join(import.meta.dir, "..", "data");
  const prototypes: Record<string, Uint8Array> = {};
  const documents: Record<string, Uint8Array> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!statSync(join(dir, rel)).isFile()) continue;
    const path = rel.split(sep).join("/");
    const bytes = new Uint8Array(readFileSync(join(dir, rel)));
    if (path.startsWith(DOCUMENTS))
      documents[path.slice(DOCUMENTS.length)] = bytes;
    else prototypes[path] = bytes;
  }
  return { prototypes: prototypeFixtureDataOf(prototypes), documents };
}

type Entry = (typeof hostEntries)[number];

const MIGRATIONS_DATA = join(PLUGINS_DIR, "database/plugins/migrations/data");

/** The migration history off disk: what the bundled source inlines. */
function diskMigrationList() {
  return migrationsFrom(
    readdirSync(MIGRATIONS_DATA)
      .filter(isMigrationFileName)
      .map((file) => ({
        file,
        sqlText: readFileSync(join(MIGRATIONS_DATA, file), "utf8"),
      })),
  );
}

/** Every migration hash the bundle carries (`bundledMigrations()`), read off disk. */
export function diskMigrationHashes(): string[] {
  return diskMigrationList().map((m) => m.hash);
}

const diskMigrations: Entry = {
  pluginPath:
    "apps/plugins/website/plugins/demos/plugins/workspace/bun-migrations",
  id: "apps.website.demos.workspace.bun-migrations",
  loader: async () => ({
    default: {
      contributions: [MigrationSource.provide({ list: diskMigrationList })],
    } satisfies ServerPluginDefinition,
  }),
  dependsOn: ["database/plugins/migrations"],
  core: null,
};

/** The repo's `config/`, read off disk: what the bundled layer inlines. */
export function diskConfigFiles(): Map<string, string> {
  const dir = join(REPO_ROOT, "config");
  const files = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!rel.endsWith(".jsonc") || !statSync(join(dir, rel)).isFile()) continue;
    files.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return files;
}
const diskGitLayer: Entry = {
  pluginPath: "apps/plugins/website/plugins/demos/plugins/workspace/bun-config",
  id: "apps.website.demos.workspace.bun-config",
  loader: async () => {
    const committedFiles = committedFilesFromMap(diskConfigFiles());
    return {
      default: {
        contributions: [
          ConfigGitLayer.provide({
            document: (storePath) =>
              Promise.resolve(committedDocument(storePath, committedFiles)),
            watch: () => Promise.resolve(() => {}),
          }),
        ],
      } satisfies ServerPluginDefinition,
    };
  },
  dependsOn: ["config_v2"],
  core: null,
};

/**
 * Host service → the disk-backed entry standing in for its bundled provider.
 * Each swapped provider must provide that one service only, or the swap would
 * drop another service with it.
 */
export const BUN_SWAPS: Readonly<Record<string, Entry>> = {
  [MigrationSource.id]: diskMigrations,
  [ConfigGitLayer.id]: diskGitLayer,
};

/** The worker's graph, its bundled-text providers swapped for the disk ones. */
export function bunHostEntries(): Entry[] {
  const swapped = new Set(
    Object.keys(BUN_SWAPS).map((service) => hostProviders[service]),
  );
  for (const [service, provider] of Object.entries(hostProviders)) {
    if (swapped.has(provider) && !(service in BUN_SWAPS))
      throw new Error(
        `[workspace demo bun host] ${provider} provides ${service} too: swapping it would drop that service`,
      );
  }
  const graph = hostEntries.filter((e) => !swapped.has(e.pluginPath));
  if (
    swapped.size !== Object.keys(BUN_SWAPS).length ||
    graph.length !== hostEntries.length - swapped.size
  )
    throw new Error(
      `[workspace demo bun host] the swapped providers (${[...swapped].join(", ")}) are not each one entry of the graph`,
    );
  return [...graph, ...Object.values(BUN_SWAPS)];
}
