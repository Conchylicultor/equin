import { sleepStampNow } from "@plugins/packages/plugins/sleep-clock/core";
import {
  mkdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  checkoutAdminDir,
  worktreeArtifacts,
  worktreesDir,
} from "@plugins/infra/plugins/paths/core";
import {
  asNamespace,
  isNamespace,
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  MAIN_SLOT_SERVED_FILE,
  parseUnserved,
  renderUnserved,
  SLOT_UNSERVED_FILE,
  slotHolderRole,
  type SlotHolder,
  type UnservedStamp,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
// This plugin's own declaration — a host-only `core/` reading its own
// `data-dirs` (a `runtimeExceptions` line in the boundary config).
import { MAIN_SLOTS_CURRENT_DIR, mainSlotsDataDir } from "../../data-dirs";
import {
  probeSlotLock,
  readSlotHolders,
  reapDeadHolders,
  type SlotLockProbe,
} from "./lease";
import { readSlotHanded, type SlotHanded } from "./handoff";
import { withSlotPool } from "./pool-lock";

// A slot is a checkout of one commit. Every running app lives in the slot it
// was built from. Keep exactly one free slot ready. (This plugin's CLAUDE.md.)

/** Where main's slots live: `<data root>/services/main-slots/`. */
export function mainSlotsDir(): AppPath {
  return mainSlotsDataDir.path;
}

/** The dir of `current` links: one per app main serves, named by its namespace. */
export function currentLinksDir(): AppPath {
  return mainSlotsDataDir.file(MAIN_SLOTS_CURRENT_DIR);
}

/** The `current` link of one app: the slot `namespace` is served from (absent before its first slot build). */
export function currentLinkFor(namespace: Namespace): AppPath {
  return joinAppPath(currentLinksDir(), namespace);
}

/** One slot of the pool. */
export interface MainSlot {
  /** Its directory name under {@link mainSlotsDir} (`slot-<n>`). */
  id: string;
  path: AppPath;
  /**
   * When it stopped serving every app (`null`: it serves one, is being
   * built, or was never served) — the order free slots are taken in.
   */
  unserved: UnservedStamp | null;
}

/**
 * Every slot in the pool, least recently served first: slots never stamped
 * unserved before any stamped one, then by when they stopped serving, then by
 * id. Empty when the pool does not exist yet.
 */
export async function listSlots(): Promise<MainSlot[]> {
  const dir = mainSlotsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const slots: MainSlot[] = [];
  for (const id of names) {
    if (id === MAIN_SLOTS_CURRENT_DIR || id.startsWith(".")) continue;
    if (id.startsWith(`${MAIN_SLOTS_CURRENT_DIR}.`)) continue; // a migration's leftovers
    const path = joinAppPath(dir, id);
    const slot = await ifStillThere(path, async () => {
      if (!(await lstat(path)).isDirectory()) return null;
      return { id, path, unserved: await readUnserved(path) };
    });
    if (slot !== null) slots.push(slot);
  }
  return slots.sort(byLeastRecentlyServed);
}

/**
 * Read one listed slot — or `null` when it vanished meanwhile (a reclaim
 * renamed it out of the pool; one holding the pool lock never races this,
 * but a lock-free reader such as `listSlots` may). A read that fails on a
 * slot still in place is an error, rethrown.
 */
async function ifStillThere<T>(
  path: AppPath,
  read: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (await linkExists(path)) throw err;
    return null;
  }
}

function byLeastRecentlyServed(a: MainSlot, b: MainSlot): number {
  const at = a.unserved === null ? -1 : Date.parse(a.unserved.at);
  const bt = b.unserved === null ? -1 : Date.parse(b.unserved.at);
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id, "en", { numeric: true });
}

async function adminFileOf(slot: AppPath, name: string): Promise<AppPath> {
  const admin = await checkoutAdminDir(slot);
  if (admin === null)
    throw new Error(`main-slots: ${slot} is not a git checkout — not a slot`);
  return joinAppPath(admin, name);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** The slot's unserved stamp (`null`: none — it serves, is built, or never served). */
export async function readUnserved(
  slot: AppPath,
): Promise<UnservedStamp | null> {
  const file = await adminFileOf(slot, SLOT_UNSERVED_FILE);
  const text = await readIfExists(file);
  return text === null ? null : parseUnserved(file, text);
}

/**
 * Stamp `slot` as having stopped serving every app at `at`, with the sleep
 * clock read now (the stamp is written as the switch is seen), so a later
 * judge takes the machine's sleep out of the span (`heldPastSwitch`).
 */
export async function stampUnserved(
  slot: AppPath,
  stamp: { at: Date; reportAfterMs: number },
): Promise<void> {
  await writeAtomically(
    await adminFileOf(slot, SLOT_UNSERVED_FILE),
    renderUnserved({
      at: stamp.at.toISOString(),
      reportAfterMs: stamp.reportAfterMs,
      asleep: sleepStampNow(),
    }),
  );
}

/** Remove the stamp: a build took the slot, or an app is served from it again. */
export async function clearUnserved(slot: AppPath): Promise<void> {
  await unlinkIfExists(await adminFileOf(slot, SLOT_UNSERVED_FILE));
}

/**
 * An app is served again from the slot holding `path` (central's spec put
 * back on the slot central kept running from, after a foreign writer moved
 * it): that slot's unserved stamp goes, so its holders' later release is not
 * read as a slow drain past a switch that never was. A path outside the pool
 * clears nothing.
 */
export async function clearUnservedAt(path: string): Promise<void> {
  await withSlotPool(async () => {
    const resolved = (await realpathIfExists(path)) ?? resolve(path);
    for (const slot of await listSlots()) {
      const at = (await realpathIfExists(slot.path)) ?? resolve(slot.path);
      if (resolved === at || resolved.startsWith(`${at}/`))
        await clearUnserved(slot.path);
    }
  });
}

/**
 * Record that main's own app is now served from `slot`. Main's only — the
 * guard bootstrap, which cannot resolve the data root its link lives in,
 * takes the most recently marked stamped slot as main's served one.
 */
export async function markSlotServed(
  slot: AppPath,
  at: Date = new Date(),
): Promise<void> {
  await writeAtomically(
    await adminFileOf(slot, MAIN_SLOT_SERVED_FILE),
    `${at.toISOString()}\n`,
  );
}

async function linkExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Is `current` still the pre-v2 single link (to main's slot) rather than the
 * dir of per-app links? Then its target is main's.
 */
async function legacyCurrent(): Promise<string | null> {
  try {
    const st = await lstat(currentLinksDir());
    return st.isSymbolicLink() ? await readlink(currentLinksDir()) : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Turn the pre-v2 single `current` link into the dir of per-app links, with
 * main's link naming what it named. Idempotent, and safe beside another
 * migration: whoever renames the old link away first migrates. For the short
 * gap in between no link exists, which every reader already handles (the
 * gateway runs from the repo root, `servedMainRoot` answers the repo).
 */
export async function migrateLegacyCurrentLink(): Promise<void> {
  const target = await legacyCurrent();
  if (target === null) return;
  const dir = currentLinksDir();
  const staged = mainSlotsDataDir.file(
    `${MAIN_SLOTS_CURRENT_DIR}.migrating.${process.pid}`,
  );
  const legacy = mainSlotsDataDir.file(
    `${MAIN_SLOTS_CURRENT_DIR}.legacy.${process.pid}`,
  );
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  await symlink(target, joinAppPath(staged, MAIN_WORKTREE_NAME));
  try {
    await rename(dir, legacy);
  } catch (err) {
    await rm(staged, { recursive: true, force: true });
    // Another process migrated first.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    await rename(staged, dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
    // A link was served into a fresh dir in the gap: keep it (it is newer),
    // and add main's only if it is still missing.
    const main = currentLinkFor(MAIN_WORKTREE_NAME);
    if (!(await linkExists(main)))
      await rename(joinAppPath(staged, MAIN_WORKTREE_NAME), main).catch(
        (e: unknown) => {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        },
      );
    await rm(staged, { recursive: true, force: true });
  }
  await unlinkIfExists(legacy);
}

/**
 * The slot `namespace` is served from, resolved — or `null` when its link
 * does not exist (never served from a slot, or a link to a slot gone).
 * Main's pre-v2 single link is read as main's.
 */
export async function servedSlotOf(
  namespace: Namespace,
): Promise<AppPath | null> {
  const legacy = await legacyCurrent();
  if (legacy !== null && namespace !== MAIN_WORKTREE_NAME) return null;
  const link = legacy !== null ? currentLinksDir() : currentLinkFor(namespace);
  try {
    return asAppPath(await realpath(link));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * The checkout whose CODE main runs: the slot main's `current` link names,
 * resolved (so a caller holds one slot even if the link moves on), or —
 * before any slot exists — the repo's main checkout.
 *
 * Not `getMainRepoRoot()` (`infra/spawn`), which is the git STORE: refs,
 * worktrees, the human's checkout `./equin push` fast-forwards.
 */
export async function servedMainRoot(): Promise<AppPath> {
  return (
    (await servedSlotOf(MAIN_WORKTREE_NAME)) ??
    (await getMainRepoRoot(REPO_ROOT))
  );
}

/**
 * Point `namespace`'s `current` link at `slot` — the step that makes `slot`
 * the one that app is served from, taken by a slot build once that app's
 * deploy is healthy (never on a failed one: the link keeps naming the slot
 * still serving). The link is made beside it and renamed over it, so a reader
 * resolves the old slot or the new one, never no link. Then: the slot is no
 * longer unserved, main's served marker moves (main only), and every slot
 * this left serving no app is stamped unserved with `drainReportAfterMs`.
 */
export async function serveSlot(
  slot: AppPath,
  namespace: Namespace,
  opts: { drainReportAfterMs: number; now?: Date },
): Promise<void> {
  await withSlotPool(() => serveSlotLocked(slot, namespace, opts));
}

async function serveSlotLocked(
  slot: AppPath,
  namespace: Namespace,
  opts: { drainReportAfterMs: number; now?: Date },
): Promise<void> {
  await migrateLegacyCurrentLink();
  const link = currentLinkFor(namespace);
  await mkdir(currentLinksDir(), { recursive: true });
  const tmp = `${link}.${process.pid}.tmp`;
  await unlinkIfExists(tmp);
  await symlink(slot, tmp);
  await rename(tmp, link);
  await clearUnserved(slot);
  if (namespace === MAIN_WORKTREE_NAME) await markSlotServed(slot, opts.now);
  await stampUnservedSlots(opts.drainReportAfterMs, opts.now);
}

/** What a slot is doing — derived, never stored. */
export type SlotStateKind = "serving" | "building" | "draining" | "free";

export interface SlotState extends MainSlot {
  state: SlotStateKind;
  /** The apps living in it: whose `current` link or spec names it. */
  servedBy: Namespace[];
  /**
   * The live holders that pin it (`slotHolderRole` `pins`: central) — apps
   * running from it whatever links and specs say, so it serves while they
   * hold it.
   */
  pinnedBy: SlotHolder[];
  /**
   * Who holds it, as its records name them (records of dead pids pruned) —
   * names only: the state is decided by the lock itself ({@link SlotState.lock}),
   * and an unheld slot lists none.
   */
  holders: SlotHolder[];
  /** How its lock was held (`null`: not probed — handed to a build, whose claim must not meet a probe). */
  lock: SlotLockProbe | null;
  /** The build it is handed to, while its hander lives. */
  handed: SlotHanded | null;
}

/**
 * Every slot of the pool with its state, least recently served first:
 *
 * - **serving** — an app's `current` link names it, or a namespace's spec
 *   does (a deploy whose new backend took over and then failed its health
 *   probe: the gateway respawns from the spec), or a holder that pins its
 *   slot runs from it (central — never a drain, so never counted against the
 *   leak limit, whatever its spec says);
 * - **building** — handed to a build, or held by one: its lock held
 *   exclusively, or shared by a build after its handover (until it exits);
 * - **draining** — serves no app, but its lock is held shared (processes it
 *   left still run from it);
 * - **free** — none of these: its lock is unheld, whatever records say.
 *
 * Held or not is the LOCK's answer (`probeSlotLock`), never the records': a
 * record names a pid, and a SIGKILLed holder's pid can be reused by an
 * unrelated process, which would keep the slot draining forever. Runs under
 * the pool lock, so no reclaim renames a slot away mid-read and no probe
 * lands in a downgrade's gap.
 */
export async function slotStates(): Promise<SlotState[]> {
  return withSlotPool(slotStatesLocked);
}

async function slotStatesLocked(): Promise<SlotState[]> {
  await migrateLegacyCurrentLink();
  const slots = await listSlots();
  if (slots.length === 0) return [];
  const servedBy = await namespacesBySlot();
  const states: SlotState[] = [];
  for (const slot of slots) {
    const state = await ifStillThere(slot.path, () => stateOf(slot, servedBy));
    if (state !== null) states.push(state);
  }
  return states;
}

async function stateOf(
  slot: MainSlot,
  servedBy: Map<string, Namespace[]>,
): Promise<SlotState> {
  const resolved = (await realpathIfExists(slot.path)) ?? resolve(slot.path);
  const by = servedBy.get(resolved) ?? [];
  const handed = await readSlotHanded(slot.path);
  const lock = handed === null ? await probeSlotLock(slot.path) : null;
  const holders = lock === "unheld" ? [] : await readSlotHolders(slot.path);
  // Records name, the lock decides: a pinning record counts only on a slot
  // whose lock is held (an unheld one lists no holders).
  const pinnedBy = holders.filter((h) => slotHolderRole(h.kind) === "pins");
  const state: SlotStateKind =
    by.length > 0 || pinnedBy.length > 0
      ? "serving"
      : handed !== null ||
          lock === "exclusive" ||
          (lock === "shared" && holders.some((h) => h.kind === "build"))
        ? "building"
        : lock === "shared"
          ? "draining"
          : "free";
  return { ...slot, state, servedBy: by, pinnedBy, holders, handed, lock };
}

/**
 * Stamp every slot that serves no app and is not being built, and has no
 * stamp yet, as unserved at `now` — called whenever an app may have left a
 * slot (`serveSlot`, a build moving central's spec, `reclaimSlots`). A
 * serving slot still carrying a stamp loses it: an app lives there (central
 * pinned a slot an older reader stamped), and a stale stamp would time its
 * co-holders' drains, and its drain once the app leaves, from the wrong
 * instant. A slot central leaves is stamped by the reclaim ending the deploy
 * that restarted it.
 */
export async function stampUnservedSlots(
  drainReportAfterMs: number,
  now: Date = new Date(),
): Promise<void> {
  await withSlotPool(async () => {
    for (const s of await slotStates()) {
      if (s.state === "serving") {
        if (s.unserved !== null) await clearUnserved(s.path);
        continue;
      }
      if (s.state === "building") continue;
      if (s.unserved !== null) continue;
      // A holder already dead when its app left never held past the switch:
      // drop its record now, unreported, so a later reap of a record found
      // here can say it held past it.
      await reapDeadHolders(s.path);
      await stampUnserved(s.path, {
        at: now,
        reportAfterMs: drainReportAfterMs,
      });
    }
  });
}

/** Every pool slot some app lives in → the namespaces naming it, by resolved path. */
async function namespacesBySlot(): Promise<Map<string, Namespace[]>> {
  const pool = await realpathIfExists(mainSlotsDir());
  const by = new Map<string, Namespace[]>();
  if (pool === null) return by;
  // A path as written may not exist (yet, or any more) — then it is read as
  // spelled, against the pool's own spelling too.
  const prefixes = [...new Set([pool, resolve(mainSlotsDir())])];
  const add = async (namespace: Namespace, path: string): Promise<void> => {
    const resolved = (await realpathIfExists(path)) ?? resolve(path);
    for (const prefix of prefixes) {
      if (!resolved.startsWith(`${prefix}/`)) continue;
      const id = resolved.slice(prefix.length + 1).split("/")[0]!;
      const key = `${pool}/${id}`;
      const list = by.get(key) ?? [];
      if (!list.includes(namespace)) list.push(namespace);
      by.set(key, list);
    }
  };
  for (const namespace of await currentLinkNamespaces()) {
    const slot = await servedSlotOf(namespace);
    if (slot !== null) await add(namespace, slot);
  }
  for (const { namespace, server } of await specServers())
    await add(namespace, server);
  return by;
}

/** The namespaces with a `current` link. */
async function currentLinkNamespaces(): Promise<Namespace[]> {
  if ((await legacyCurrent()) !== null) return [MAIN_WORKTREE_NAME];
  let names: string[];
  try {
    names = await readdir(currentLinksDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter(isNamespace).map(asNamespace);
}

/** The `server` dir every namespace's spec names (unreadable specs are an error: one may name a slot). */
async function specServers(): Promise<
  { namespace: Namespace; server: string }[]
> {
  let names: string[];
  try {
    names = await readdir(worktreesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const servers: { namespace: Namespace; server: string }[] = [];
  for (const name of names) {
    if (!isNamespace(name)) continue;
    const namespace = asNamespace(name);
    const path = worktreeArtifacts.spec(namespace);
    const text = await readIfExists(path);
    if (text === null) continue;
    const spec = JSON.parse(text) as { server?: unknown };
    if (typeof spec.server !== "string")
      throw new Error(`main-slots: ${path} names no server`);
    servers.push({ namespace, server: spec.server });
  }
  return servers;
}

/**
 * Is `path` (a checkout, or a path in one) inside main's slot pool? Resolved
 * on both sides, so a path spelled through a link compares like the slot's
 * own. False for a path that does not exist (a slot since removed).
 */
export async function isInSlotPool(path: string): Promise<boolean> {
  const [pool, resolved] = await Promise.all([
    realpathIfExists(mainSlotsDir()),
    realpathIfExists(path),
  ]);
  return pool !== null && resolved !== null && resolved.startsWith(`${pool}/`);
}

/**
 * The spelling of checkout `root` that stays valid for as long as something
 * launched from it runs. A main SLOT is checked out again (or reclaimed) once
 * no build or backend holds it, so a path into it, handed to a process that
 * outlives the backend (an agent's hook commands, its guards root), names a
 * directory that disappears: it becomes main's `current` link instead
 * (`current/<main namespace>` — a composition's too: the code is main's), which
 * always resolves to the slot main serves at that moment. Any other checkout
 * (a worktree) lives as long as its agents and is returned as is.
 */
export async function durableCheckoutRoot(root: string): Promise<string> {
  return (await isInSlotPool(root)) ? currentLinkFor(MAIN_WORKTREE_NAME) : root;
}
