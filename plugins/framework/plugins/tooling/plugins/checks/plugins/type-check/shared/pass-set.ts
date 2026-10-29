// A content-keyed PASS set on disk: "this exact key was recorded green before".
//
// Every store of type-check is this store with different keys — the per-file
// lint result store (key = a file's path and version), the type check's name
// records (key = a file's path and version), its contracts (key = a `.d.ts`
// text's hash) and the run and walk bases. Every entry is one small JSON file,
// read and parsed whole. All are host-global on purpose: a fresh worktree
// reuses whatever a sibling recorded for an identical key, which is the whole
// reason the key is content-addressed rather than tree- or worktree-scoped.
//
// AGE LIVES IN THE DIRECTORY, NOT IN EACH FILE. Entries sit in GENERATIONS —
// `generations/g<N>/`, N = floor(now / period), period = maxAgeMs /
// generations — so what has expired is read off the generation names, and an
// open costs the same at 50k entries as at 5M:
//
//   - `record` writes into the current generation;
//   - `read` / `has` / `touch` probe newest first, and a hit in an older
//     generation is PROMOTED: hard-linked into the current one (atomic, one
//     syscall, at most once per entry per period) — so the bound is "unused
//     for maxAgeMs", least recently used, as a per-read mtime used to say;
//   - an open lists only `generations/` and drops every generation older
//     than the window whole: renamed aside at once (no reader sees it again),
//     then unlinked at most `REMOVE_PER_OPEN` entries per open. What eviction
//     costs is what it evicts, spread over opens, never the live entries.
//
// An entry last used at t is kept for more than `minLifetimeMs` and at most
// `maxAgeMs` after t. Until 2026-10-27 each entry's mtime was its age, and
// every open listed the whole directory (~160k contracts) and an hourly
// sweep stat-ed every entry (one 9 CPU-s system-time spike): O(store) on
// every run. See research/2026-10-27-global-type-check-store-generations.md.
//
// The flat `<dir>/<sha>.json` entries written before the switch are read as
// one more, oldest generation (promoted like any other) until `maxAgeMs` has
// passed since the generations were created, then no longer read and removed
// a budget per open — so no host goes cold.
//
// Sharing one implementation means the atomic write, the bounds and the
// eviction are written once. Each store still declares its OWN data dir
// (`data-dirs/index.ts`), because the reclaim audit describes directories,
// not code.

import { createHash } from "crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { DataDir } from "@plugins/infra/plugins/paths/core";

/** What a store needs of its data dir: its path, a child's path, and `mkdir -p`. */
export type PassSetDir = Pick<DataDir, "path" | "file" | "ensure">;

/** How the store is bounded. AGE is the evictor; count is a disk backstop. */
export interface PassSetBounds {
  /** An entry unused for this long is gone (kept at least `minLifetimeMs`). */
  maxAgeMs: number;
  /**
   * How many generations the age bound is cut into: more keeps an unused
   * entry closer to `maxAgeMs`, and costs a miss one more probe.
   */
  generations: number;
  /**
   * Disk backstop: directory entries across the window. A promoted entry is
   * one more entry (a hard link: no more disk), so this counts each entry
   * once per generation it is in. Over it, the oldest generation is dropped
   * early. Read off a per-generation write counter (approximate: a lost
   * concurrent increment undercounts), never by listing.
   */
  maxEntries: number;
}

/**
 * The shortest time an entry is kept after its last use (exclusive): it was
 * used at the very start of its generation's period, and is dropped when the
 * window has moved on by `generations` periods.
 */
export function minLifetimeMs(bounds: PassSetBounds): number {
  return (bounds.maxAgeMs / bounds.generations) * (bounds.generations - 1);
}

/** What an open is handed besides its bounds. Tests drive the clock. */
export interface PassSetOptions {
  now?: () => number;
  /** Entries an open may unlink (dropped generations, legacy). Default `REMOVE_PER_OPEN`. */
  removeBudget?: number;
}

/**
 * Entries one open unlinks at most: ~0.2 sys-CPU-s. A dropped generation of
 * 50k entries is gone after ~25 opens — a few hours of the fleet's checks —
 * and invisible to readers from the moment it was renamed aside.
 */
const REMOVE_PER_OPEN = 2000;

/** The generations' home inside the store's dir (the flat legacy layout beside it). */
const LAYOUT_DIR = "generations";
/** When the generations were created (ms, as text): dates the legacy sweep. */
const BORN_FILE = ".born";
/** Present once the flat legacy entries are gone (or there were none). */
const LEGACY_SWEPT_FILE = ".legacy-swept";
/** How many entries a generation gained (records and promotions), as text. */
const WRITES_FILE = ".writes";
/** A dropped generation, renamed aside so no reader sees it half-removed. */
const TRASH_PREFIX = ".trash-";

const GEN_NAME = /^g(\d+)$/;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

export interface PassSet {
  /**
   * True iff an entry is stored for this key. Presence is use: a hit in an
   * older generation is promoted, so an entry a caller checked is not
   * dropped before it reads it (a base checks its shards, then reads them).
   */
  has(key: string): boolean;
  /**
   * The entry recorded for this key, parsed — or undefined when there is none.
   * For a store whose entries carry data (the lint result store), not only a
   * verdict; the caller owns the entry's shape. Marks it used.
   */
  read(key: string): unknown;
  /**
   * Record an entry in the current generation. Atomic (write-then-rename).
   * `detail` is written into the entry: for a human reading the directory, or
   * for `read`.
   */
  record(key: string, detail: Record<string, unknown>): void;
  /** Mark an entry used now without reading it. False when there is no such entry. */
  touch(key: string): boolean;
}

/** What opens cost in this process: the store floor a run pays, for its cost line. */
export interface PassSetOpenStats {
  opens: number;
  ms: number;
  /** Generations dropped (age or count), and entries unlinked (dropped or legacy). */
  dropped: number;
  removed: number;
}

const openStats: PassSetOpenStats = {
  opens: 0,
  ms: 0,
  dropped: 0,
  removed: 0,
};

/** This process's pass-set opens so far. */
export function passSetOpenStats(): PassSetOpenStats {
  return { ...openStats };
}

/** Open (and lazily create) a content-keyed PASS set under `dir`. */
export function openPassSet(
  dir: PassSetDir,
  bounds: PassSetBounds,
  options: PassSetOptions = {},
): PassSet {
  if (!(bounds.generations >= 2) || !Number.isInteger(bounds.generations)) {
    throw new Error(
      `pass-set ${dir.path}: generations must be an integer ≥ 2 (got ${bounds.generations}): with one, an entry used just before its period ends is dropped at once`,
    );
  }
  const t0 = performance.now();
  const now = options.now ?? Date.now;
  const period = bounds.maxAgeMs / bounds.generations;
  // A genuinely unwritable home is a real fault and should surface loudly.
  dir.ensure();
  const home = join(dir.path, LAYOUT_DIR);
  const born = bornAt(dir, home, now());
  // Removal is bounded per open: what an open evicts is renamed aside (or, for
  // legacy entries, no longer probed) at once, and unlinked a budget at a time
  // across opens — so no single run pays a whole generation's unlinks
  // (~5.5 sys-CPU-s per 50k entries, measured).
  const budget = { left: options.removeBudget ?? REMOVE_PER_OPEN };
  dropExpired(home, Math.floor(now() / period), bounds, budget);
  let legacy = !exists(join(home, LEGACY_SWEPT_FILE));
  if (legacy && now() - born > bounds.maxAgeMs) {
    // Expired: never read again, whether or not this open finishes the sweep.
    legacy = false;
    sweepLegacy(dir, home, budget);
  }
  openStats.opens++;
  openStats.ms += performance.now() - t0;

  const current = (): number => Math.floor(now() / period);
  const genFile = (gen: number, sha: string): string =>
    join(home, `g${gen}`, `${sha}.json`);
  // Newest first: the current generation, the older ones in the window, then
  // the flat legacy entry while there may be one.
  const locations = (sha: string): { path: string; gen: number | null }[] => {
    const cur = current();
    const out: { path: string; gen: number | null }[] = [];
    for (let g = cur; g > cur - bounds.generations; g--) {
      out.push({ path: genFile(g, sha), gen: g });
    }
    if (legacy) out.push({ path: dir.file(`${sha}.json`), gen: null });
    return out;
  };
  // Run `write` against the current generation, creating it (and the layout
  // dir, should a test have removed the store under an open set) on ENOENT.
  const inCurrent = (write: (gen: string) => void): void => {
    const gen = join(home, `g${current()}`);
    try {
      write(gen);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
      mkdirSync(gen, { recursive: true });
      write(gen);
    }
  };
  // The generation's entry count, read and rewritten whole. Two writers at
  // once can lose an increment: a backstop's count may run a little low.
  const counted = (gen: string): void => {
    const file = join(gen, WRITES_FILE);
    writeFileSync(file, String(countIn(file) + 1));
  };
  // Hard-link an older generation's entry into the current one. False when
  // the source vanished (its generation dropped under us).
  const promote = (from: string, sha: string): boolean => {
    let linked = true;
    inCurrent((gen) => {
      try {
        linkSync(from, join(gen, `${sha}.json`));
        counted(gen);
      } catch (err) {
        const code = errCode(err);
        // Already there: a concurrent promotion or record got there first.
        if (code === "EEXIST") return;
        // The source's generation was dropped between the probe and the link.
        if (code === "ENOENT" && !exists(from)) {
          linked = false;
          return;
        }
        throw err;
      }
    });
    return linked;
  };
  // Find the entry, promoting it when it is older than the current
  // generation. The path holding it now, or undefined.
  const usedAt = (sha: string): string | undefined => {
    const cur = current();
    for (const loc of locations(sha)) {
      if (!exists(loc.path)) continue;
      if (loc.gen === cur) return loc.path;
      if (promote(loc.path, sha)) return genFile(cur, sha);
    }
    return undefined;
  };

  return {
    has(key) {
      return usedAt(sha256(key)) !== undefined;
    },
    read(key) {
      const sha = sha256(key);
      const cur = current();
      for (const loc of locations(sha)) {
        let text: string;
        try {
          text = readFileSync(loc.path, "utf8");
        } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
          continue;
        }
        // Promoted after the read: if the source vanished in between, the
        // text read is still this key's entry — it is simply not kept.
        if (loc.gen !== cur) promote(loc.path, sha);
        return JSON.parse(text) as unknown;
      }
      return undefined;
    },
    record(key, detail) {
      const sha = sha256(key);
      const body = JSON.stringify({ ...detail, recordedAt: now() });
      inCurrent((gen) => {
        // Per writer: two processes recording one key never share a tmp file.
        const tmp = join(gen, `.${sha.slice(0, 12)}-${process.pid}.tmp`);
        writeFileSync(tmp, body);
        renameSync(tmp, join(gen, `${sha}.json`)); // atomic on the same filesystem
        counted(gen);
      });
    },
    touch(key) {
      return usedAt(sha256(key)) !== undefined;
    },
  };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    return false;
  }
}

// When the generations were created: read, or — the first open ever — written
// atomically (a tmp file hard-linked into place, so a racing opener either
// wins or reads a complete value). The creator also decides whether there
// are legacy entries to keep reading: none, and the sweep is done already.
function bornAt(dir: PassSetDir, home: string, now: number): number {
  const file = join(home, BORN_FILE);
  try {
    return Number(readFileSync(file, "utf8"));
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  mkdirSync(home, { recursive: true });
  const tmp = join(home, `.born-${process.pid}.tmp`);
  writeFileSync(tmp, String(now));
  try {
    linkSync(tmp, file);
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    unlinkSync(tmp);
    return Number(readFileSync(file, "utf8"));
  }
  unlinkSync(tmp);
  if (!hasLegacyEntry(dir)) markLegacySwept(home);
  return now;
}

// Whether the flat layout holds any entry: stops at the first one, so a store
// full of legacy entries costs one directory block, not a listing.
function hasLegacyEntry(dir: PassSetDir): boolean {
  const d = opendirSync(dir.path);
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (e.name.endsWith(".json")) return true;
    }
    return false;
  } finally {
    d.closeSync();
  }
}

function markLegacySwept(home: string): void {
  closeSync(openSync(join(home, LEGACY_SWEPT_FILE), "w"));
}

interface Budget {
  left: number;
}

// Unlink up to the budget's entries of `dir` that `remove` selects (opendir:
// stops after what it removed, never lists the rest). True when the
// directory held no more such entries.
function drain(
  dir: string,
  budget: Budget,
  remove: (name: string) => boolean,
): boolean {
  let d;
  try {
    d = opendirSync(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return true;
    throw err;
  }
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (!remove(e.name)) continue;
      if (budget.left <= 0) return false;
      budget.left--;
      // A concurrent drainer may have taken it first.
      rmSync(join(dir, e.name), { force: true });
      if (e.name.endsWith(".json")) openStats.removed++;
    }
    return true;
  } finally {
    d.closeSync();
  }
}

// The flat layout, swept once ever, a budget at a time: every legacy entry
// (and the old sweep's marker and stray tmp files). Marked swept once none
// is left, so the opens after it list nothing.
function sweepLegacy(dir: PassSetDir, home: string, budget: Budget): void {
  const done = drain(
    dir.path,
    budget,
    (name) =>
      name.endsWith(".json") ||
      name === ".last-prune" ||
      (name.startsWith(".") && name.endsWith(".tmp")),
  );
  if (done) markLegacySwept(home);
}

// Drop every generation older than the window, then — the count backstop —
// the oldest ones while the window holds more than `maxEntries` (never the
// current), then unlink what the budget allows of every dropped one. Lists
// `generations/` only: a handful of names.
function dropExpired(
  home: string,
  cur: number,
  bounds: PassSetBounds,
  budget: Budget,
): void {
  const live: number[] = [];
  const trash: string[] = [];
  for (const name of readdirSync(home)) {
    if (name.startsWith(TRASH_PREFIX)) {
      trash.push(name);
      continue;
    }
    const m = GEN_NAME.exec(name);
    if (m === null) continue;
    const gen = Number(m[1]);
    if (gen <= cur - bounds.generations) trash.push(dropGeneration(home, gen));
    else live.push(gen);
  }
  live.sort((a, b) => a - b); // oldest first
  let total = live.reduce((sum, g) => sum + entriesIn(home, g), 0);
  while (total > bounds.maxEntries && live.length > 1 && live[0] !== cur) {
    const gen = live.shift()!;
    total -= entriesIn(home, gen);
    trash.push(dropGeneration(home, gen));
  }
  for (const name of trash) {
    if (name === "") continue; // a racing dropper took it
    const dir = join(home, name);
    if (drain(dir, budget, () => true)) {
      try {
        rmdirSync(dir);
      } catch (err) {
        // A concurrent drainer removed it, or is still unlinking into it.
        const code = errCode(err);
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
      }
    }
  }
}

function entriesIn(home: string, gen: number): number {
  return countIn(join(home, `g${gen}`, WRITES_FILE));
}

// A generation's write counter: 0 when absent, or when a racing write left
// it empty (the backstop is approximate, never a reason to fail an open).
function countIn(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    return 0;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

// Renamed aside — atomic, so a reader probing it sees the whole generation or
// none of it — and returned by its trash name, for `dropExpired` to unlink a
// budget at a time. "" when a racing dropper renamed it first.
function dropGeneration(home: string, gen: number): string {
  const trash = `${TRASH_PREFIX}g${gen}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(join(home, `g${gen}`), join(home, trash));
  } catch (err) {
    if (errCode(err) === "ENOENT") return "";
    throw err;
  }
  openStats.dropped++;
  return trash;
}
