import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { mintPrototype } from "../shared/mint";
import { prototypeUrlFormatter } from "./prototype-url";

/**
 * `./equin prototype new [title]` — the terminal spelling of the mint.
 *
 * Calls {@link mintPrototype} straight against the filesystem rather than
 * `POST /api/prototypes`, which is the point of having the verb at all: the
 * prototypes tree is host-global and outside every checkout, so a folder can be
 * minted with no backend running and nothing built. The endpoint and this share
 * the mint, so they cannot produce differently-shaped prototypes.
 *
 * Prints the id first, on its own line: it is what the agent writes into a
 * message (where active-data turns it into a chip) and what names the folder.
 */
export const newPrototypeAction: CliAction<
  [string | undefined],
  object
> = async (title) => {
  const { id, dir } = await mintPrototype(title === undefined ? {} : { title });
  const url = await prototypeUrlFormatter();

  console.log(id);
  console.log(`  folder: ${dir}`);
  console.log(`  url:    ${url(id)}`);
};
