import {
  readText,
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";

/** A cache lookup: the stored SVG, or a miss. */
export type CoverLookup = { hit: true; svg: string } | { hit: false };

/** Where rendered covers are kept, by cache key. */
export interface CoverStore {
  read(key: string): Promise<CoverLookup>;
  write(key: string, svg: string): Promise<void>;
}

/**
 * The cover store over a file root: one `<key>.svg` per cover. The root's
 * writes are atomic, so a concurrent reader (another worktree's backend shares
 * the desktop's host-global dir) never observes a half-written SVG.
 */
export function fileRootCoverStore(root: Mount): CoverStore {
  const pathOf = (key: string) => relPath(`${key}.svg`);
  return {
    async read(key) {
      const read = await readText(root, pathOf(key));
      return read.kind === "missing"
        ? { hit: false }
        : { hit: true, svg: read.text };
    },
    async write(key, svg) {
      await root.write(pathOf(key), svg, {
        writer: { kind: "system", reason: "a Sonata cover rendered" },
      });
    },
  };
}
