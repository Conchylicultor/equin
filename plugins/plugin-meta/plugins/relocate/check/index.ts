import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { pluginMentionsFold } from "@plugins/plugin-meta/plugins/plugin-refs/core";
import {
  movedPluginId,
  parsePluginMoves,
  PLUGIN_MOVES_FILE,
  type PluginMove,
} from "../core";

const RULE = "relocate:moved-plugins-unnamed";
const MAX_SHOWN = 50;

const dirOf = (id: PluginId) => `plugins/${asFsPath(id)}`;

/** Where `id` lives now: followed through every later entry of the ledger. */
function currentId(id: PluginId, later: readonly PluginMove[]): PluginId {
  let at = id;
  for (const m of later) at = movedPluginId(at, m.from, m.to) ?? at;
  return at;
}

/**
 * No file still names a plugin the move ledger moved away, and no file sits
 * under its old directory — the two traces a move leaves when something
 * escaped it: a mention the mover did not rewrite (a dot id it only reports),
 * and work that landed on the old path afterwards (a rebase onto a main commit
 * that added a file there, or that git's rename detection carried into the new
 * directory with the old name still inside it).
 *
 * An entry is skipped while its old directory is a plugin again (its
 * `package.json` is tracked): the name was reused, and every mention of it is
 * that plugin's.
 */
/** Each moved-away id (its old directory no longer a plugin), with where it lives now. */
async function goneIds(repo: RepoFiles): Promise<Map<PluginId, PluginId>> {
  const ledger = await repo.read(PLUGIN_MOVES_FILE);
  if (ledger === null)
    throw new Error(`${PLUGIN_MOVES_FILE} is not in the repo file set`);
  const moves = parsePluginMoves(ledger);
  const gone = new Map<PluginId, PluginId>();
  moves.forEach((m, i) => {
    if (repo.has(`${dirOf(m.from)}/package.json`)) return;
    gone.set(m.from, currentId(m.from, moves.slice(i)));
  });
  return gone;
}

const movedPluginsUnnamed = defineFoldCheck({
  id: RULE,
  description:
    "no file names a plugin path (with or without its leading plugins/) or dot id the plugin-move ledger moved away, and none sits under its old directory",
  exemptable: {
    [RULE]:
      "still names a moved-away plugin on purpose (a record of the move, a stored identity kept under its old name)",
  },
  // Dated records name what existed then; derived files follow their source.
  outOfScope: ["research", "generated"],
  context: async (ctx) => ({
    ids: [...(await goneIds(await ctx.repo())).keys()].sort(),
  }),
  // Folded along the directory tree: after an edit only the edited files are
  // read and scanned. With nothing moved away there is nothing to look for.
  files: (repo, { ids }) => (ids.length === 0 ? [] : repo.all()),
  facts: async (ctx) => goneIds(await ctx.repo()),
  fold: pluginMentionsFold,
  async verdict(mentions, { facts: gone }, ctx) {
    if (gone.size === 0) return { ok: true };
    const repo = await ctx.repo();
    const exempt = await ctx.exempt(RULE);
    const problems: string[] = [];
    for (const [id, now] of gone) {
      for (const f of repo.under(dirOf(id))) {
        if (exempt.skips(f)) continue;
        problems.push(
          `  ${f} — under the old directory of ${id}; it belongs in ${dirOf(now)}`,
        );
      }
    }
    for (const m of mentions) {
      if (exempt.skips(m.file)) continue;
      const now = gone.get(m.id)!;
      const spelled =
        m.form === "path"
          ? dirOf(now)
          : m.form === "fs-path"
            ? asFsPath(now)
            : now;
      problems.push(`  ${m.file}:${m.line} — ${m.value} (now ${spelled})`);
    }
    if (problems.length === 0) return { ok: true };

    const more =
      problems.length > MAX_SHOWN
        ? `\n  … +${problems.length - MAX_SHOWN} more`
        : "";
    return {
      ok: false,
      message:
        `${problems.length} trace(s) of moved plugins:\n` +
        problems.slice(0, MAX_SHOWN).join("\n") +
        more,
      hint:
        "Each plugin named here was moved (`./equin plugin move`, recorded in " +
        `${PLUGIN_MOVES_FILE}). Move a file under an old directory to the new one; rewrite a mention to the ` +
        "new name. A dot id that names stored data (a job name, a row's plugin id) needs that data migrated " +
        `before it is renamed — or, kept on purpose, an exemption in the file's plugin's exempt/index.ts (rule ${RULE}).`,
    };
  },
});

export default movedPluginsUnnamed;
