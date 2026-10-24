import { implement } from "@plugins/infra/plugins/endpoints/server";
import { createPrototype, listPrototypes } from "../../core";
import { mintPrototype } from "../../shared/mint";
import { listPrototypeMetas } from "./list";

/** `GET /api/prototypes` → the prototype list (JSON, via implement()). */
export const handleList = implement(listPrototypes, async () => {
  return listPrototypeMetas();
});

/**
 * `POST /api/prototypes` → mint a prototype, answer with its id.
 *
 * No list notification here: the mint writes a folder into the watched tree, so
 * the same file watcher that reacts to an agent's edit is what re-broadcasts the
 * list. One signal for "the tree moved", not two.
 */
export const handleCreate = implement(createPrototype, async ({ body }) => {
  const { id } = await mintPrototype({ title: body.title });
  return { id };
});
