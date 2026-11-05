import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readdirSync, statSync } from "@plugins/packages/plugins/timed-fs/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/core";
import type { GuardContext } from "./types";
import type { Walk, WalkRoot } from "./walk-roots";

/**
 * Where an agent's walk may start. An allowlist, not a list of known-huge
 * places: the home directory has no bound on what lands in it (Downloads,
 * `~/.claude/projects`, a cloned monorepo), so the only roots that are safe by
 * construction are the ones whose contents the system itself bounds.
 *
 * - the agent's own workspace (`ctx.workRoot`), and a data dir it may write to;
 * - the main checkout — except, for a walk that does not skip gitignored and
 *   hidden entries, the directories holding `.claude/worktrees` (~290 other
 *   checkouts, each with its node_modules);
 * - ONE thing below a shared parent: one worktree's data dir
 *   (`<worktreesDir()>/<name>/…`), one temp dir (`/tmp/<x>/…`) — never the
 *   parent itself;
 * - anything that is not a directory: a file is read, not walked, and a missing
 *   path walks nothing.
 *
 * Outside those, an explicit depth bound is the opt-in: a name-only walk
 * (`fd`, `find`, `tree`, `rg --files`) of at most 2 levels, a content search
 * of 1 (2 levels of `~/.claude/projects` already reads every transcript).
 */
export type WalkVerdict =
  { ok: true } | { ok: false; root: WalkRoot; reason: string };

const MAX_NAME_DEPTH = 2;
const MAX_CONTENT_DEPTH = 1;
/**
 * A glob expanding to more entries than this is refused without looking at
 * each one: the hook would stat them all, and a command naming that many
 * things outside the workspace is the wide walk itself.
 */
const MAX_EXPANSION = 256;

function insideOrEqual(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);
}

function strictlyInside(p: string, dir: string): boolean {
  return p !== dir && insideOrEqual(p, dir);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Nothing there (or not reachable as a directory): the command walks
    // nothing and reports the error itself.
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
      return false;
    throw err;
  }
}

/** The shared parents an agent may walk ONE child of. */
function sharedParents(): string[] {
  return [
    ...new Set(["/tmp", "/private/tmp", resolve(tmpdir())]),
    worktreesDir(),
  ];
}

/**
 * A one-segment glob: each entry it expands to, judged as a root of its own —
 * unless the directory it expands in is already fine to walk whole.
 */
function judgeExpansion(
  root: WalkRoot & { expands: NonNullable<WalkRoot["expands"]> },
  walk: Walk,
  ctx: GuardContext,
): WalkVerdict {
  const dir = { raw: root.raw, path: root.path };
  // Fine whole, or a shared parent: every entry is then one thing below it.
  if (sharedParents().includes(root.path) || judgeRoot(dir, walk, ctx).ok)
    return { ok: true };
  let names: string[];
  try {
    names = readdirSync(root.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true };
    throw err;
  }
  const matched = names.filter((n) => root.expands.segment.test(n));
  if (matched.length > MAX_EXPANSION)
    return {
      ok: false,
      root: dir,
      reason: `the glob expands to ${matched.length} entries outside your workspace (\`${ctx.workRoot}\`)`,
    };
  for (const name of matched) {
    const path = join(root.path, name, root.expands.rest);
    const v = judgeRoot({ raw: root.raw, path }, walk, ctx);
    if (!v.ok) return v;
  }
  return { ok: true };
}

function judgeRoot(root: WalkRoot, walk: Walk, ctx: GuardContext): WalkVerdict {
  if (root.expands)
    return judgeExpansion({ ...root, expands: root.expands }, walk, ctx);
  const p = root.path;
  if (insideOrEqual(p, ctx.workRoot)) return { ok: true };
  if (ctx.writableDataDirs.some((d) => insideOrEqual(p, d)))
    return { ok: true };

  const main = ctx.protectedRoot;
  if (main !== null && insideOrEqual(p, main)) {
    const worktrees = join(main, ".claude", "worktrees");
    if (walk.honoursIgnores || !insideOrEqual(worktrees, p))
      return { ok: true };
    if (!isDirectory(p)) return { ok: true };
    return {
      ok: false,
      root,
      reason: `it holds \`${worktrees}\` — every agent's checkout, each with its node_modules — and \`${walk.command}\` does not skip gitignored or hidden directories`,
    };
  }

  if (sharedParents().some((d) => strictlyInside(p, d))) return { ok: true };
  if (!isDirectory(p)) return { ok: true };

  const bound = walk.readsContent ? MAX_CONTENT_DEPTH : MAX_NAME_DEPTH;
  if (walk.maxDepth !== null && walk.maxDepth <= bound) return { ok: true };
  return {
    ok: false,
    root,
    reason: `it is outside your workspace (\`${ctx.workRoot}\`) and not a bounded place to search`,
  };
}

/** The first root of `walk` an agent may not start from, if any. */
export function judgeWalk(walk: Walk, ctx: GuardContext): WalkVerdict {
  for (const root of walk.roots) {
    const v = judgeRoot(root, walk, ctx);
    if (!v.ok) return v;
  }
  return { ok: true };
}
