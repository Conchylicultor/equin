import { existsSync } from "node:fs";
import { join } from "node:path";
import { replaceElementText } from "@plugins/infra/plugins/html-decode/core";
import {
  copyTree,
  joinRel,
  readText,
  relPath,
  stageThenRename,
  type Mount,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { diskDirMount } from "@plugins/infra/plugins/paths/plugins/data-files/machine";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { PROTOTYPE_ENTRY_FILE, protoIdKind } from "../../core";
import type { HistoryStore } from "../../server";

// THE one way a prototype comes into existence.
//
// Before this, a prototype folder was created by an agent running
// `cp -R _template <name>`: the naming, the flat-folder rule and the copy were
// all the agent's to get right, and there was no write path on the server at
// all. Two surfaces call this instead — the gallery's New prototype button
// (`POST /api/prototypes`, before it launches the agent) and `./equin
// prototype new` — so the id, the template it starts from and the atomic copy
// are decided once here rather than re-derived per caller.
//
// `machine/`, because it reads the running checkout's template off disk (the
// endpoint is `needsMachine`); the CLI reaches it here too, with no backend
// running. The folder itself goes through the tree's `Mount`.

/** The template's folder in the repo's `prototypes/`. */
const TEMPLATE_DIR_NAME = "_template";

/**
 * How many ids to draw before giving up. A collision needs two mints in the same
 * SECOND to land on the same 1-in-1.7M suffix, so one retry is already
 * theatrical; the bound exists so a genuinely broken tree (a `dest` that always
 * looks present) fails loudly instead of spinning forever.
 */
const MAX_MINT_ATTEMPTS = 8;

export interface MintInto {
  /** The prototypes tree the folder is minted into. */
  files: Mount;
  /** Its version history — the mint records `v0`. */
  history: Pick<HistoryStore, "ensureHistory">;
  /** Who mints: the request's origin, or the CLI. */
  writer: WriteOrigin;
}

/**
 * Create a new prototype: a freshly minted id'd folder in the prototypes tree,
 * holding a copy of the blank template.
 *
 * `title` stamps the copy's `<title>`, which is where every surface reads a
 * prototype's display name from — there is no `meta.json`. Omit it and the card
 * reads the template's own "Untitled prototype" until the agent writes, which is
 * honest: the prototype does exist. The stamp lands in the staging copy, before
 * the folder becomes visible.
 *
 * Built out of sight and renamed into place, never over an existing folder
 * (`stageThenRename`): every worktree backend and the CLI write into the ONE
 * shared tree, so a half-copied folder must never be visible, and a lost race
 * is a collision the mint re-draws around.
 *
 * The new prototype's version history starts here: its `v0` is the folder as
 * minted.
 *
 * Returns the id (which IS the folder name, and the URL segment). Throws on
 * failure — there is no id-shaped empty value a caller could mistake for a mint.
 */
export async function mintPrototype(
  into: MintInto,
  opts: { title?: string } = {},
): Promise<{ id: string }> {
  const template = diskDirMount(await templateDir());
  const { title } = opts;

  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const id = protoIdKind.mint();
    const outcome = await stageThenRename(
      into.files,
      relPath(id),
      async (staging) => {
        await copyTree(template, relPath(), into.files, staging, into.writer);
        if (title !== undefined) await stampTitle(into, staging, title);
      },
      into.writer,
    );
    // A name collision re-mints rather than throwing: the caller asked for a
    // prototype, not for this particular id, and the folder that is already
    // there belongs to somebody else's mint.
    if (outcome === "target-exists") continue;

    // v0 is the page as minted — the blank template, titled — so the first
    // agent turn shows as the full diff of what it designed.
    await into.history.ensureHistory(id);
    return { id };
  }

  throw new Error(
    `could not mint a prototype id after ${MAX_MINT_ATTEMPTS} attempts — every folder drawn already exists`,
  );
}

/**
 * Absolute path of the blank template a mint copies: `prototypes/_template/`
 * in the checkout that is RUNNING — main's app mints from main's template, a
 * worktree's deploy (or CLI) from its own branch's.
 *
 * The template is code: reviewed, versioned, and read where it lives. There is
 * deliberately no copy of it in the data dir — a copy seeded once and never
 * overwritten is how every template change after the seed silently stopped
 * reaching new prototypes.
 *
 * Throws when the checkout has no template — a mint with nothing to copy has
 * no empty-but-fine answer to return.
 */
async function templateDir(): Promise<string> {
  const dir = join(await getWorktreeRoot(), "prototypes", TEMPLATE_DIR_NAME);
  if (!existsSync(dir)) {
    throw new Error(`no prototype template to copy: ${dir} does not exist`);
  }
  return dir;
}

/**
 * Rewrite the `<title>` of a freshly copied prototype's `index.html`.
 *
 * Spliced in by `html-decode` — the same parser the lister reads metadata
 * with — so everything the template says other than its title survives byte for
 * byte, and the text is escaped on the way in rather than interpolated into
 * markup. The first `<title>` is the one rewritten: it is the one the lister
 * reads.
 *
 * A template with no `<title>` throws instead of quietly writing the file back
 * unchanged: the caller passed a name and would otherwise get a card reading
 * "Untitled prototype" with nothing to explain it.
 */
async function stampTitle(
  into: MintInto,
  dir: RelPath,
  title: string,
): Promise<void> {
  const indexHtml = joinRel(dir, PROTOTYPE_ENTRY_FILE);
  const read = await readText(into.files, indexHtml);
  if (read.kind === "missing") {
    throw new Error(
      `cannot stamp a title: ${indexHtml} is missing — the template is not a valid prototype`,
    );
  }

  const rewritten = replaceElementText(read.text, "title", title);
  if (rewritten.kind === "absent") {
    throw new Error(
      `cannot stamp a title: ${indexHtml} has no <title> element to write into`,
    );
  }

  await into.files.write(indexHtml, rewritten.html, { writer: into.writer });
}
