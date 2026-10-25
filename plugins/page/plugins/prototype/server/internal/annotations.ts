import { readPrototypeTitle } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { prototypeBlock } from "../../core";

/**
 * The `title` of the prototype each prototype block among `rows` shows — the
 * annotated `title` on `<prototype id="…" title="…"/>`, this plugin's
 * `Editor.BlockAnnotation` contribution.
 *
 * Read from each prototype's own `index.html` (`readPrototypeTitle`), never
 * by validating the whole tree: a page names a handful of prototypes, the tree
 * holds every one. A block whose prototype is gone gets no `title` at all —
 * the line still carries the id, and an absent title is the document saying
 * "nothing is there".
 */
export async function resolvePrototypeTitles(
  rows: readonly { id: string; type: string; data: unknown }[],
): Promise<ReadonlyMap<string, Record<string, string>>> {
  const blocks: { id: string; prototypeId: string }[] = [];
  for (const row of rows) {
    if (row.type !== prototypeBlock.type) continue;
    // Validated against this very schema at the write boundary — a failure
    // here is a corrupt row, and loud.
    const { prototypeId } = prototypeBlock.parse(row.data);
    // An unfilled block (its picker) shows nothing yet.
    if (prototypeId !== "") blocks.push({ id: row.id, prototypeId });
  }
  const byBlock = new Map<string, Record<string, string>>();
  if (blocks.length === 0) return byBlock;

  const ids = [...new Set(blocks.map((b) => b.prototypeId))];
  const titles = new Map(
    await Promise.all(
      ids.map(async (id) => [id, await readPrototypeTitle(id)] as const),
    ),
  );
  for (const block of blocks) {
    const read = titles.get(block.prototypeId);
    if (read?.found) byBlock.set(block.id, { title: read.title });
  }
  return byBlock;
}
