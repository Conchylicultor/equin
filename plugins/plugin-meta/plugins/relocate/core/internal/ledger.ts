// The committed record of every plugin move. `plugin move` appends to it in the
// same commit as the code it moves, and every `./equin build` replays the
// entries its namespace has not seen onto that namespace's user-layer config
// (`applyPluginMoves`). So saved settings follow the code that reads them, per
// checkout, with no step for anyone to remember.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";

/** Repo-relative path of the ledger. */
export const PLUGIN_MOVES_FILE =
  "plugins/plugin-meta/plugins/relocate/core/plugin-moves.json";

const pluginMoveSchema = z.object({
  /** When the move was made (ISO). Part of the entry's identity, so the same
   *  `from → to` made twice (a move, its revert, the move again) is three
   *  entries, each applied once. */
  at: z.string(),
  from: z.string().transform(asPluginId),
  to: z.string().transform(asPluginId),
});

export type PluginMove = z.infer<typeof pluginMoveSchema>;

/** An entry's identity: what a namespace records once it has applied it. */
export function pluginMoveKey(m: PluginMove): string {
  return `${m.at} ${m.from} ${m.to}`;
}

/** The ledger as committed in the checkout at `root`, in the order moves were made. */
export function readPluginMoves(root: string): PluginMove[] {
  const file = join(root, PLUGIN_MOVES_FILE);
  // The ledger ships with the plugin; a checkout without it predates it and
  // has no moves to replay.
  if (!existsSync(file)) return [];
  return z
    .array(pluginMoveSchema)
    .parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Append one move to the ledger in the checkout at `root`. */
export function appendPluginMove(
  root: string,
  move: { from: PluginId; to: PluginId },
): PluginMove {
  const entry: PluginMove = { at: new Date().toISOString(), ...move };
  const all = [...readPluginMoves(root), entry];
  writeFileSync(
    join(root, PLUGIN_MOVES_FILE),
    `${JSON.stringify(all, null, 2)}\n`,
  );
  return entry;
}

/**
 * Where `id` lands after moving `from` to `to`: `from` itself or one of its
 * descendants is re-rooted; anything else is null (not moved).
 */
export function movedPluginId(
  id: string,
  from: PluginId,
  to: PluginId,
): PluginId | null {
  if (id === from) return to;
  if (id.startsWith(`${from}.`)) return asPluginId(to + id.slice(from.length));
  return null;
}
