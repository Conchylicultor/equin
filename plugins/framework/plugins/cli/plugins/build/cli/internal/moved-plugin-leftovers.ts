// Main's build refuses to run over what a plugin move left at the old address.
//
// `./equin plugin move` moves what git tracks. What git never tracked — a
// plugin's build output, ignored by the plugin's OWN `.gitignore` — stays where
// it was in every checkout that pulls the move, and the `.gitignore` that hid it
// has moved away with the plugin. Git now sees those files, so plugin discovery
// reads the old address as a plugin: docgen writes it a CLAUDE.md and lists it
// in the tracked plugin docs, and the main-tree guard fails the build with
// "this build changed files git tracks on main" — true, but it names the docs,
// not the cause (2026-11-13: the menu-bar crate's `rust/gen/` after 7283f257a1,
// build-1794577996-2l51v3 and every main build after it).
//
// The move ledger (`relocate/core`, `plugin-moves.json`) says which addresses a
// plugin left. Untracked, un-ignored files at such an address are what the move
// left behind, so main's build stops before its first writer and names them,
// with the move. It does not delete them: a leftover is usually build output,
// but it can be something someone needs (a local file, data the moved plugin
// should have carried). That call is for whoever investigates the failed build.
// An address git tracks something under again is a plugin living there, not a
// leftover, and is left alone.
//
// Main only: in a worktree such a file can be an agent's unpushed work, and
// there `relocate:moved-plugins-unnamed` already names it.

import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { type AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { asFsPath } from "@plugins/framework/plugins/plugin-id/core";
import {
  PLUGIN_MOVES_FILE,
  readPluginMoves,
  type PluginMove,
} from "@plugins/plugin-meta/plugins/relocate/core";

const GIT_TIMEOUT_MS = 60_000;

/** Repo-relative folder a move left. */
export function movedFromDir(move: Pick<PluginMove, "from">): string {
  return `plugins/${asFsPath(move.from)}`;
}

async function gitFiles(root: AppPath, args: string[]): Promise<string[]> {
  const result = await spawnCaptured(["git", "ls-files", "-z", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split("\0").filter((p) => p.length > 0);
}

export interface MoveLeftover {
  move: PluginMove;
  dir: string;
  /** Untracked, un-ignored files under `dir`, repo-relative. */
  files: string[];
}

/** Every old plugin address in the checkout at `root` holding only untracked, un-ignored files. */
export async function findMovedPluginLeftovers(
  root: AppPath,
): Promise<MoveLeftover[]> {
  const leftovers: MoveLeftover[] = [];
  const seen = new Set<string>();
  // Latest move first, so a reused-then-moved-again address names its last move.
  for (const move of [...readPluginMoves(root)].reverse()) {
    const dir = movedFromDir(move);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const files = await gitFiles(root, [
      "--others",
      "--exclude-standard",
      "--",
      dir,
    ]);
    if (files.length === 0) continue;
    if ((await gitFiles(root, ["--", dir])).length > 0) continue;
    leftovers.push({ move, dir, files });
  }
  return leftovers;
}

const SHOWN_PER_DIR = 10;

/** The build's error for `leftovers` (non-empty). */
export function describeMoveLeftovers(leftovers: MoveLeftover[]): string {
  const lines = [
    "ERROR: main's checkout holds files a plugin move left behind.",
    "",
  ];
  for (const { move, dir, files } of leftovers) {
    lines.push(
      `${dir}/ — ${move.from} moved to ${move.to} (${move.at}); git tracks nothing here, but these files remain, un-ignored:`,
    );
    for (const f of files.slice(0, SHOWN_PER_DIR)) lines.push(`  ${f}`);
    if (files.length > SHOWN_PER_DIR) {
      lines.push(`  … and ${files.length - SHOWN_PER_DIR} more`);
    }
    lines.push("");
  }
  lines.push(
    "`plugin move` moves what git tracks. Anything else stays at the old address, and once the moved",
    "plugin's .gitignore no longer covers it, plugin discovery reads the old address as a plugin, and",
    "this build would rewrite tracked docs for it. Nothing was built and nothing was deleted.",
    "",
    "Look at each file before removing anything. Build output the moved plugin regenerates (it is",
    "ignored at the new address) can be deleted; anything else may need to move to the new address",
    `first. Moves are recorded in ${PLUGIN_MOVES_FILE}.`,
  );
  return lines.join("\n");
}

/**
 * Fail main's build when it holds move leftovers: print every one, with its
 * move, and exit 1 — the build's exit hooks close its receipt and ledger row as
 * failed (the main-tree guard's own exit), and the backend keeps serving the
 * previous deploy.
 */
export async function assertNoMoveLeftovers(root: AppPath): Promise<void> {
  const leftovers = await findMovedPluginLeftovers(root);
  if (leftovers.length === 0) return;
  console.error(describeMoveLeftovers(leftovers));
  process.exit(1);
}
