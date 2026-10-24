import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { PROTOTYPES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  pickedColor,
  protoIdKind,
  resolvePicks,
  statusOf,
  type PrototypeMeta,
} from "../core";
import { listPrototypeMetas } from "../shared/list-metas";
import { openPicksStore, type PicksStore } from "../shared/picks";
import { openStatusStore } from "../shared/status";
import { prototypeUrlFormatter } from "./prototype-url";

/**
 * `./equin prototype list` — every prototype on disk, with the URL that
 * opens it and, when the user has picked a variant other than the defaults,
 * which one.
 *
 * Reads the tree through the same `listPrototypeMetas()` the server's list
 * endpoint and live resource use — it sits in `shared/` precisely so this
 * process can call it — rather than fetching `GET /api/prototypes`. So the verb
 * answers with no backend running, and there is one implementation of "read the
 * metas" rather than a terminal-shaped second one that could disagree with the
 * gallery.
 *
 * A deleted prototype (`deletedAt` in its status) is left out, as the gallery
 * leaves it out; a last line counts them, so they are not silently missing.
 *
 * An empty tree is a legitimate answer (nobody has authored a mock yet), not a
 * failure, so it prints as a sentence instead of nothing at all — a bare empty
 * output would read as "the command is broken".
 */
const run: CliAction<[], object> = async () => {
  const statuses = await openStatusStore(prototypesDir.path).readAll();
  const all = await listPrototypeMetas();
  const metas = all.filter(
    (m) => statusOf(statuses, m.name).deletedAt === null,
  );
  const deleted = all.length - metas.length;
  if (metas.length === 0) {
    if (deleted > 0) {
      console.log(deletedLine(deleted));
      return;
    }
    console.log(`No prototypes yet in ${PROTOTYPES_DIR_DISPLAY}.`);
    console.log(`Create one with: ./equin prototype new "My mock"`);
    return;
  }

  const url = await prototypeUrlFormatter();
  const picksStore = openPicksStore(prototypesDir.path);
  const width = Math.max(...metas.map((m) => m.name.length));
  for (const meta of metas) {
    console.log(`${meta.name.padEnd(width)}  ${meta.title}`);
    console.log(`${" ".repeat(width)}  ${url(meta.name)}`);
    const picked = await pickedLine(picksStore, meta);
    if (picked !== null) console.log(`${" ".repeat(width)}  ${picked}`);
    // A malformed folder is listed, never hidden — same rule as the gallery
    // card, which shows the problems rather than dropping the prototype.
    for (const problem of meta.problems) {
      const where = problem.path === "" ? "" : `${problem.path}: `;
      console.log(`${" ".repeat(width)}  ! ${where}${problem.detail}`);
    }
  }
  if (deleted > 0) console.log(`\n${deletedLine(deleted)}`);
};

/** `2 deleted prototypes not shown (the gallery's Trash).` */
function deletedLine(count: number): string {
  return `${String(count)} deleted prototype${count === 1 ? "" : "s"} not shown (the gallery's Trash).`;
}

/**
 * `picked: palette=azure, accent=#3b82f6 (azure)` — the variant the user is
 * looking at, when it is not the page as written. A color reads as its hex,
 * with its suggestion's name when it is one. The user's shared picks, judged
 * against the live page's options like the pane judges them; the details (and
 * the variant's own URL) are `prototype options <id>`.
 */
async function pickedLine(
  store: PicksStore,
  meta: PrototypeMeta,
): Promise<string | null> {
  // A hand-made folder is not referenceable by id, so it has no picks — the
  // server refuses to store any for it.
  if (!protoIdKind.is(meta.name) || meta.options.length === 0) return null;
  const picks = resolvePicks(meta.options, await store.read(meta.name));
  const parts = meta.options.flatMap((option) => {
    const value = picks[option.name];
    if (value === undefined) return [];
    if (option.kind === "choice") return [`${option.name}=${value}`];
    const hex = pickedColor(option, picks);
    return [`${option.name}=${hex}${value === hex ? "" : ` (${value})`}`];
  });
  if (parts.length === 0) return null;
  return `picked: ${parts.join(", ")}`;
}

export default run;
