import { rename } from "node:fs/promises";
import type { DataDir } from "@plugins/infra/plugins/paths/core";

/** A cache lookup: the stored SVG, or a miss. */
export type CoverLookup = { hit: true; svg: string } | { hit: false };

/** Where rendered covers are kept, by cache key. */
export interface CoverStore {
  read(key: string): Promise<CoverLookup>;
  write(key: string, svg: string): Promise<void>;
}

/**
 * The cover store over a data dir: one `<key>.svg` per cover.
 *
 * Writes go to a temp file then `rename`, so a concurrent reader (another
 * worktree's backend shares this host-global dir) never observes a
 * half-written SVG.
 */
export function diskCoverStore(
  dir: Pick<DataDir, "file" | "ensure">,
): CoverStore {
  const pathOf = (key: string) => dir.file(`${key}.svg`);
  return {
    async read(key) {
      const file = Bun.file(pathOf(key));
      if (!(await file.exists())) return { hit: false };
      return { hit: true, svg: await file.text() };
    },
    async write(key, svg) {
      dir.ensure();
      const tmp = dir.file(`.${key}.${crypto.randomUUID()}.tmp`);
      await Bun.write(tmp, svg);
      await rename(tmp, pathOf(key));
    },
  };
}
