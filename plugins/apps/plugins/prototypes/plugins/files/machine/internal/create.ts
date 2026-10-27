import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { createPrototype } from "../../core";
import { gitHistory } from "./history-provider";
import { mintPrototype } from "./mint";

/**
 * `POST /api/prototypes` → mint a prototype, answer with its id.
 *
 * No list notification here: the mint writes a folder into the watched tree, so
 * the same watch that reacts to an agent's edit is what re-broadcasts the
 * list. One signal for "the tree moved", not two.
 */
export const handleCreate = implementMachine(
  createPrototype,
  async ({ body, req }) => {
    const { id } = await mintPrototype(
      { files: prototypesFiles, history: gitHistory, writer: originOf(req) },
      { title: body.title },
    );
    return { id };
  },
);
