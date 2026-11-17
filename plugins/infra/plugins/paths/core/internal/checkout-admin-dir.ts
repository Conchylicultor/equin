import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  exists,
  readFile,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  MAIN_SLOT_STAMP,
  SLOT_LOCK_FILE,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";

// A checkout's ADMIN DIR: the app's own directory inside that checkout's git dir
// (`<git dir>/<lock dir>/`). Per checkout — the main checkout's git dir is
// `<root>/.git`, a linked worktree's `<common>/worktrees/<name>` — so two
// checkouts of one repository never share one, and inside the git dir so git
// never lists what it holds and no checkout of the code carries it. A main
// slot's lease and its holder records (`infra/git/main-slots`) and the
// main-slot stamp below live here.

/** The `.git` entry's two forms: a directory (a main checkout), a `gitdir:` file (a linked one). */
function gitDirFromDotGitFile(root: AppPath, text: string): AppPath {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match === null) {
    throw new Error(
      `${root}/.git is a file but names no "gitdir:" — not a git checkout git can read either`,
    );
  }
  const gitDir = match[1]!.startsWith("/") ? match[1]! : join(root, match[1]!);
  return asAppPath(gitDir);
}

/**
 * Where a main slot's lease lives (`infra/git/main-slots`): one file,
 * `<admin dir>/tree.lock`. `null` when `root` is not a git checkout.
 */
export async function checkoutLockPath(root: AppPath): Promise<AppPath | null> {
  const admin = await checkoutAdminDir(root);
  return admin === null ? null : joinAppPath(admin, SLOT_LOCK_FILE);
}

/**
 * `root`'s admin dir, or `null` when `root` is not a git checkout (a compiled
 * release, a temp copy). Never creates it.
 */
export async function checkoutAdminDir(root: AppPath): Promise<AppPath | null> {
  const dotGit = joinAppPath(root, ".git");
  if (!(await exists(dotGit))) return null;
  const gitDir = (await stat(dotGit)).isDirectory()
    ? dotGit
    : gitDirFromDotGitFile(root, await readFile(dotGit, "utf8"));
  return joinAppPath(gitDir, LEGACY_IDS.gitLockDir);
}

// ── The main-slot stamp ────────────────────────────────────────────────────
//
// A main slot (`infra/git/main-slots`) is a linked worktree main builds and
// serves from. Whether a checkout IS one is provenance, recorded when the slot
// is made: a stamp in its admin dir. `checkoutRef` reads it (a slot of the repo
// main is served from counts as main), and it cannot ask the main-slots plugin
// where its slots live — that plugin's data-dir declaration reads this barrel,
// so the edge would be a cycle. The stamp also states the fact rather than
// inferring it from a location: `git worktree remove` deletes it with the slot.

/** Record that `root` (a linked worktree just made) is a main slot. */
export async function stampMainSlot(root: AppPath): Promise<void> {
  const dir = await checkoutAdminDir(root);
  if (dir === null)
    throw new Error(`stampMainSlot: ${root} is not a git checkout`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    joinAppPath(dir, MAIN_SLOT_STAMP),
    `${JSON.stringify({ stampedAt: new Date().toISOString() })}\n`,
  );
}

/** Was `root` made as a main slot ({@link stampMainSlot})? */
export async function isMainSlotCheckout(root: AppPath): Promise<boolean> {
  const dir = await checkoutAdminDir(root);
  if (dir === null) return false;
  return exists(joinAppPath(dir, MAIN_SLOT_STAMP));
}

/**
 * Is `root` a checkout no work may be done in — its repository's own main
 * checkout (where `./equin push` lands commits) or a main slot (what main is
 * built and served from)? The question a command that edits, commits or
 * upgrades asks before refusing to run on main. Unlike `checkoutRef`, it is
 * about the repository `root` belongs to, not about which repository serves
 * main: another clone's main checkout is refused too.
 */
export async function isMainCheckoutOrSlot(root: AppPath): Promise<boolean> {
  const mainRoot = await getMainRepoRoot(root);
  if (resolve(root) === resolve(mainRoot)) return true;
  return isMainSlotCheckout(root);
}
