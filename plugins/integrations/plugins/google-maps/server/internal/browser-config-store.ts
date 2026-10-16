import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { googleMapsDir } from "../../data-dirs";
import type { MapsBrowserConfigValue } from "../../core";

// Host-global, like the Places key: one file every checkout reads. The name is
// exported so the watcher can pick this file's events out of the directory's.
//
// Functions, not consts: `DataDir.path` is resolved per read because the data
// root is env-overridable, so a path frozen at module eval could be wrong.
export const BROWSER_CONFIG_FILENAME = "browser-config.json";
const configPath = (): string => googleMapsDir.file(BROWSER_CONFIG_FILENAME);

// The on-disk shape. A hand-edited file that no longer parses throws from the
// loader rather than reading as `unset` — a broken file is not "no key".
const StoredSchema = z.object({
  browserKey: z.string().min(1),
  mapId: z.string().min(1).optional(),
});
type Stored = z.infer<typeof StoredSchema>;

async function readStored(): Promise<Stored | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return StoredSchema.parse(JSON.parse(raw));
}

export async function readBrowserConfig(): Promise<MapsBrowserConfigValue> {
  const stored = await readStored();
  if (stored === null) return { kind: "unset" };
  return {
    kind: "set",
    browserKey: stored.browserKey,
    mapId: stored.mapId ?? null,
  };
}

/**
 * Replace the stored config. Written to a sibling and renamed over the target,
 * so another checkout's watcher-triggered read never sees a half-written file.
 */
async function writeStored(stored: Stored): Promise<void> {
  googleMapsDir.ensure();
  const target = configPath();
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(stored, null, 2));
  await rename(staging, target);
}

/** Store (or replace) the browser key, keeping a stored Map ID. */
export async function writeBrowserKey(browserKey: string): Promise<void> {
  const stored = await readStored();
  await writeStored({
    browserKey,
    ...(stored?.mapId === undefined ? {} : { mapId: stored.mapId }),
  });
}

/** Why a Map ID could not be stored. */
export class NoBrowserKeyError extends Error {
  constructor() {
    super("Save the browser key before the Map ID");
  }
}

/** Store (or replace) the Map ID beside the stored key; throws `NoBrowserKeyError` when there is none. */
export async function writeMapId(mapId: string): Promise<void> {
  const stored = await readStored();
  if (stored === null) throw new NoBrowserKeyError();
  await writeStored({ browserKey: stored.browserKey, mapId });
}

/** Drop the Map ID, keeping the key. No file is no Map ID already. */
export async function clearMapId(): Promise<void> {
  const stored = await readStored();
  if (stored === null) return;
  await writeStored({ browserKey: stored.browserKey });
}

export async function clearBrowserConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}
