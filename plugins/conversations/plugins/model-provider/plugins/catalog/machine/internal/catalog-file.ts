import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BASELINE_MODELS,
  ModelCatalogSchema,
  type ModelCatalog,
} from "@plugins/conversations/plugins/model-provider/core";

// The on-disk half of the catalog: one JSON file, read whole, rewritten whole
// (tmp + rename, so a reader never sees half a file). Every function takes its
// path, so a test drives a temp dir.

export type CatalogFileRead =
  | { kind: "absent" }
  | { kind: "ok"; catalog: ModelCatalog }
  | { kind: "invalid"; error: string };

/** Read the catalog file. Synchronous: it is a few KB, and the launch path needs it without an await. */
export function readCatalogFile(file: string): CatalogFileRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "invalid", error: `not JSON: ${err.message}` };
  }
  const parsed = ModelCatalogSchema.safeParse(json);
  if (!parsed.success)
    return {
      kind: "invalid",
      error: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  return { kind: "ok", catalog: parsed.data };
}

/** The catalog file names something unreadable. Never papered over with the baseline: that would forget retirements. */
export class ModelCatalogUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(
      `the model catalog ${file} is unreadable (${reason}) — fix or remove it; removing it restores the baseline and forgets every discovered version and retirement`,
    );
    this.name = "ModelCatalogUnreadableError";
  }
}

/** The catalog a file holds: the baseline while there is none, a throw while it is unreadable. */
export function catalogFromFile(file: string): ModelCatalog {
  const read = readCatalogFile(file);
  switch (read.kind) {
    case "absent":
      return BASELINE_MODELS;
    case "ok":
      return read.catalog;
    case "invalid":
      throw new ModelCatalogUnreadableError(file, read.error);
  }
}

/**
 * Rewrite the catalog whole, atomically: a reader (every backend's watcher)
 * sees the old file or the new one, never half of either. There is one writer
 * — the host's discovery job, a singleton on the host's main backend — so no
 * lock is needed to keep two writers from losing each other's update.
 */
export async function writeCatalogFile(
  file: string,
  catalog: ModelCatalog,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
