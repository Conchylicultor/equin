// What lets moves chain in one diff: each move records the paths it touched,
// and the next one accepts a dirty tree only when every dirty path is one an
// earlier, still-uncommitted move recorded. An unrelated edit still blocks.
//
// The record lives in the checkout's git dir, not in the committed ledger: it
// describes one uncommitted diff, is meaningless once that diff is committed,
// and a move's file list (hundreds of paths) would sit in the ledger forever.

import { writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { z } from "zod";
import { pluginMoveKey, type PluginMove } from "../../core";

/** File name, inside the checkout's git dir. */
export const TOUCHED_FILE = "equin-plugin-moves-touched.json";

const touchedSchema = z.record(z.string(), z.array(z.string()));
type Touched = z.infer<typeof touchedSchema>;

/** The touched-path record in git dir `gitDir` (none yet: empty). */
export function readTouched(gitDir: string): Touched {
  const file = join(gitDir, TOUCHED_FILE);
  if (!existsSync(file)) return {};
  return touchedSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Record the paths `entry` touched, keeping the other entries' records. */
export function recordTouched(
  gitDir: string,
  entry: PluginMove,
  paths: Iterable<string>,
): void {
  const all = readTouched(gitDir);
  all[pluginMoveKey(entry)] = [...new Set(paths)].sort();
  writeFileSync(
    join(gitDir, TOUCHED_FILE),
    `${JSON.stringify(all, null, 2)}\n`,
  );
}

/**
 * Every path `git status --porcelain=v1 -z --untracked-files=all` names: both
 * sides of a rename or copy, since the old path is as dirty as the new one.
 */
export function parsePorcelainZ(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === "") continue;
    const xy = f.slice(0, 2);
    paths.push(f.slice(3));
    if (xy.includes("R") || xy.includes("C")) paths.push(fields[++i]!);
  }
  return paths;
}

export type DirtVerdict =
  | { kind: "clean" }
  | { kind: "chained"; moves: PluginMove[] }
  | { kind: "unexplained"; paths: string[] };

/**
 * Whether the dirty paths are exactly the work of earlier uncommitted moves.
 * `uncommitted` are the ledger entries the working tree has and HEAD does not;
 * `always` are paths any move may leave dirty (the ledger itself).
 */
export function judgeDirt(input: {
  dirty: readonly string[];
  uncommitted: readonly PluginMove[];
  touched: Touched;
  always: readonly string[];
}): DirtVerdict {
  if (input.dirty.length === 0) return { kind: "clean" };
  const allowed = new Set(input.always);
  for (const m of input.uncommitted)
    for (const p of input.touched[pluginMoveKey(m)] ?? []) allowed.add(p);
  const paths =
    input.uncommitted.length === 0
      ? [...input.dirty]
      : input.dirty.filter((p) => !allowed.has(p));
  if (paths.length > 0) return { kind: "unexplained", paths };
  return { kind: "chained", moves: [...input.uncommitted] };
}
