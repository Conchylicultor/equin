// The demo's browser host as Bun boots it — the build taking its snapshot
// (`./browser-host.snapshot.ts`) and the boot test (`./browser-host.test.ts`).
//
// Bun cannot evaluate a vite `import.meta.glob`, so the two providers whose
// data is bundled text are swapped for the same data read off disk
// (`framework/browser-server/bun-host`'s `withDiskProviders`). Every other
// entry is the graph the worker boots. The seed's own bundled input — the demo's prototypes and their
// thumbnails, and the user's Documents — is read off disk the same way
// (`diskDemoData`).

import {
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join, sep } from "node:path";
import {
  diskMigrationList,
  withDiskProviders,
} from "@plugins/framework/plugins/browser-server/plugins/bun-host/cli";
import { prototypeFixtureDataOf } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import type { DemoSeedData } from "./seed";
import { hostEntries, hostProviders } from "./browser-host.generated";

const HOME = "home/";
const SONGS = "songs/";

/** The demo's `data/` folder off disk, as the seed reads it. */
export function diskDemoData(): DemoSeedData {
  const dir = join(import.meta.dir, "..", "data");
  const prototypes: Record<string, Uint8Array> = {};
  const home: Record<string, Uint8Array> = {};
  const songs: Record<string, Uint8Array> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!statSync(join(dir, rel)).isFile()) continue;
    const path = rel.split(sep).join("/");
    const bytes = new Uint8Array(readFileSync(join(dir, rel)));
    if (path.startsWith(HOME)) home[path.slice(HOME.length)] = bytes;
    else if (path.startsWith(SONGS)) songs[path.slice(SONGS.length)] = bytes;
    else prototypes[path] = bytes;
  }
  return { prototypes: prototypeFixtureDataOf(prototypes), home, songs };
}

/** Every migration hash the bundle carries (`bundledMigrations()`), read off disk. */
export function diskMigrationHashes(): string[] {
  return diskMigrationList().map((m) => m.hash);
}

/** The worker's graph, its bundled-text providers swapped for the disk ones. */
export function bunHostEntries() {
  return withDiskProviders(hostEntries, hostProviders);
}
