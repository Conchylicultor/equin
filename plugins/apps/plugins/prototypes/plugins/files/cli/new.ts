import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { mintPrototype } from "../machine/internal/mint";
import { prototypeUrlFormatter } from "./prototype-url";
import { cliFiles, cliHistory } from "./tree";

/**
 * `./equin prototype new [title]` — the terminal spelling of the mint.
 *
 * Calls {@link mintPrototype} straight against the data dir on disk rather than
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
  const { id } = await mintPrototype(
    {
      files: cliFiles(),
      history: cliHistory(),
      writer: systemOrigin("./equin prototype new"),
    },
    title === undefined ? {} : { title },
  );
  const dir = prototypesDir.file(id);
  const url = await prototypeUrlFormatter();

  console.log(id);
  console.log(`  folder: ${dir}`);
  console.log(`  url:    ${url(id)}`);
};
