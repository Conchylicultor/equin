import { isAbsolute, join, sep } from "node:path";
import {
  readdir,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import type { ClosureSince } from "@plugins/packages/plugins/source-digest/core";
import type { BootInput } from "@plugins/build/plugins/restart-skip/plugins/hooks/core";
import type { AdoptRequest, AdoptVerdict, ChildIncarnation } from "../core";

/**
 * What the judgement reads of the running process. Plain data, so a test
 * hands a made-up process over a temp tree; the handler reads the real one
 * (`./process-view`).
 */
export interface ProcessView {
  /** When the process started (ms since the epoch): nothing it loaded predates its start. */
  startedAtMs: number;
  /** The Bun binary it runs on. */
  bin: string;
  /** The serving entry it was spawned with. */
  entry: string;
  /** Every module it has loaded so far, eager and lazy (absolute paths). */
  loaded: readonly string[];
  /**
   * Files the runtime reads once at start and resolves every later import by
   * (tsconfig paths, bunfig, the root package.json), absolute.
   */
  runtimeInputs: readonly string[];
  /** The contributed `RestartSkip.BootInput`s. */
  bootInputs: readonly BootInput[];
  /** Every live worker or child that dies with this process. */
  children: readonly ChildIncarnation[];
  /**
   * source-digest's `closureChangedSince`, handed in by the runtime's half
   * (the server and central barrels both serve it; `shared/` reaches neither).
   */
  closureSince: (
    entries: readonly string[],
    sinceMs: number,
  ) => Promise<ClosureSince>;
}

const NODE_MODULES = `${sep}node_modules${sep}`;

/**
 * Would a backend spawned now run exactly the code `p` runs? Only then is a
 * restart a no-op, and only then is the answer `adopted`. Every check fails
 * toward a restart, with the reason: `restart` for what the deploy changed
 * (or a declared limit), `cannot-judge` when the closure walk could not
 * measure the code at all — a defect of the judgement the deploy reports,
 * never a quiet `restart`.
 *
 * The rule is "nothing it loaded, or could still load, changed since it
 * started", read by inode change time (`closureChangedSince` explains why that
 * is exact: no revert, no rewrite of equal bytes and no re-pointed package
 * passes it). Not a comparison of digests: equal bytes do not prove a lazily
 * imported module was not loaded while they were different.
 *
 * 1. The spawn: the same binary (and unreplaced since the start) and the same
 *    entry.
 * 2. What the runtime read once (tsconfig, bunfig, package.json) and what a
 *    plugin read once (`RestartSkip.BootInput`): untouched.
 * 3. Every module already loaded — repo files and package files alike:
 *    untouched, so its bytes are still the ones evaluated.
 * 4. The closure of the entry on disk now (literal dynamic imports followed),
 *    which is what a fresh process would load and this one may still load
 *    lazily: walkable, untouched — files and package resolution entries — and
 *    holding every repo module already loaded.
 * 5. Every live child that dies with this process (a supervised worker or
 *    process — the restart would respawn it from the new tree): its binary
 *    and the closure of its module entries untouched since IT was spawned. A
 *    child whose code cannot be pointed at refuses.
 */
export async function judgeAdoption(
  p: ProcessView,
  req: AdoptRequest,
): Promise<AdoptVerdict> {
  const restart = (reason: string): AdoptVerdict => ({
    kind: "restart",
    reason,
  });
  const cannotJudge = (reason: string): AdoptVerdict => ({
    kind: "cannot-judge",
    reason,
  });
  const since = p.startedAtMs;

  if ((await realpathOr(p.bin)) !== (await realpathOr(req.bin))) {
    return restart(
      `the deploy spawns another Bun (${req.bin}, running ${p.bin})`,
    );
  }
  if ((await realpathOr(p.entry)) !== (await realpathOr(req.entry))) {
    return restart(
      `the deploy spawns another entry (${req.entry}, running ${p.entry})`,
    );
  }

  const inputs = [
    { what: "the Bun binary", paths: [p.bin] },
    { what: "the runtime's resolution inputs", paths: p.runtimeInputs },
    ...p.bootInputs,
  ];
  for (const input of inputs) {
    const changed = await firstChanged(await expand(input.paths), since);
    if (changed !== null) return restart(`${input.what}: ${changed}`);
  }

  const loadedChanged = await firstChanged(p.loaded, since);
  if (loadedChanged !== null) {
    return restart(`a loaded module: ${loadedChanged}`);
  }

  // From the entry's real path: resolution answers real paths, as the loader's
  // keys are.
  const closure = await p.closureSince([await realpath(p.entry)], since);
  switch (closure.kind) {
    case "unmeasurable":
      return cannotJudge(`the closure cannot be measured: ${closure.reason}`);
    case "changed":
      return restart(
        `the closure: ${describe(closure.path, closure.changedAtMs)}`,
      );
    case "unchanged":
      break;
  }
  // A repo module loaded that the closure no longer reaches: what this
  // process holds is not what a fresh one would load.
  const stray = p.loaded.find(
    (m) => !m.includes(NODE_MODULES) && !closure.files.has(m),
  );
  if (stray !== undefined) {
    return restart(`a loaded module the closure no longer reaches: ${stray}`);
  }
  for (const child of p.children) {
    const why = await childChanged(child, p.closureSince);
    if (why === null) continue;
    const reason = `the child ${child.label}: ${why.reason}`;
    return why.blind ? cannotJudge(reason) : restart(reason);
  }
  return { kind: "adopted" };
}

/**
 * Why `child` may not be running what a respawn now would (`blind`: its
 * closure could not be measured), or `null`.
 */
async function childChanged(
  child: ChildIncarnation,
  closureSince: ProcessView["closureSince"],
): Promise<{ reason: string; blind: boolean } | null> {
  const { code, spawnedAtMs } = child;
  const changed = (reason: string) => ({ reason, blind: false });
  if (code === null || code.entries === null) {
    return changed("it runs code this process cannot point at");
  }
  if (code.binary !== null) {
    if (!isAbsolute(code.binary)) {
      return changed(
        `its executable is resolved through PATH (${code.binary})`,
      );
    }
    const moved = await firstChanged([code.binary], spawnedAtMs);
    if (moved !== null) return changed(moved);
  }
  const entries = await Promise.all(code.entries.map((e) => realpath(e)));
  const closure = await closureSince(entries, spawnedAtMs);
  switch (closure.kind) {
    case "unmeasurable":
      return {
        reason: `its closure cannot be measured: ${closure.reason}`,
        blind: true,
      };
    case "changed":
      return changed(describe(closure.path, closure.changedAtMs));
    case "unchanged":
      return null;
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return `(missing) ${path}`;
    throw err;
  }
}

/** `paths`, each directory followed by its direct entries. */
async function expand(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    out.push(path);
    let s;
    try {
      s = await stat(path);
    } catch (err) {
      // Reported by `firstChanged` as gone.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (s.isDirectory()) {
      for (const entry of await readdir(path)) out.push(join(path, entry));
    }
  }
  return out;
}

const STAT_BATCH = 64;

/** The first of `paths` that changed since `sinceMs` (or is gone), described; `null` when none did. */
async function firstChanged(
  paths: readonly string[],
  sinceMs: number,
): Promise<string | null> {
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    const batch = paths.slice(i, i + STAT_BATCH);
    const found = await Promise.all(
      batch.map(async (path) => {
        try {
          const { ctimeMs } = await stat(path);
          return ctimeMs >= sinceMs ? describe(path, ctimeMs) : null;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return `${path} is gone`;
          }
          throw err;
        }
      }),
    );
    const hit = found.find((f) => f !== null);
    if (hit !== undefined) return hit;
  }
  return null;
}

function describe(path: string, changedAtMs: number): string {
  return `${path} changed at ${new Date(changedAtMs).toISOString()}`;
}
