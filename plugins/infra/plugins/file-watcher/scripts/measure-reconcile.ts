// Measures what a periodic reconcile would repair that the watch itself did not
// report: watches each dir with the engine, and every `--every` seconds walks it
// and compares every file's (mtime, size) with the previous walk. A file that
// moved with no event naming it (or a dir above it), and no `onLost` since the
// previous walk, is a change only a timer could have caught.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/measure-reconcile.ts \
//     --minutes 20 --every 30 <dir> [<dir> …]
//
// Research: research/2026-10-25-infra-file-watcher-reconcile-to-onlost.md
import { lstat, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { createFileWatcher } from "../shared/engine";

type Snapshot = Map<string, string>;

interface DirState {
  dir: string;
  named: Set<string>;
  lost: number;
  prev: Snapshot;
  walks: number;
  walkMs: number;
  moved: number;
  unheard: string[];
  lostTotal: number;
}

function parseArgs(argv: string[]): {
  minutes: number;
  everyS: number;
  dirs: string[];
} {
  let minutes = 20;
  let everyS = 30;
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--minutes") minutes = Number(argv[++i]);
    else if (a === "--every") everyS = Number(argv[++i]);
    else dirs.push(a);
  }
  if (dirs.length === 0)
    throw new Error("usage: [--minutes N] [--every S] <dir>…");
  return { minutes, everyS, dirs };
}

async function walk(dir: string, out: Snapshot): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) {
      try {
        const s = await lstat(p);
        out.set(p, `${s.mtimeMs}:${s.size}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
}

/** Whether an event named `path` or a directory above it. */
function heard(named: Set<string>, path: string): boolean {
  for (
    let p = path;
    p.length > 0;
    p = p.slice(0, Math.max(0, p.lastIndexOf(sep)))
  ) {
    if (named.has(p)) return true;
  }
  return false;
}

async function snapshot(dir: string): Promise<{ snap: Snapshot; ms: number }> {
  const t0 = performance.now();
  const snap: Snapshot = new Map();
  await walk(dir, snap);
  return { snap, ms: performance.now() - t0 };
}

const { minutes, everyS, dirs } = parseArgs(process.argv.slice(2));
const states: DirState[] = [];
for (const dir of dirs) {
  const state: DirState = {
    dir,
    named: new Set(),
    lost: 0,
    prev: (await snapshot(dir)).snap,
    walks: 0,
    walkMs: 0,
    moved: 0,
    unheard: [],
    lostTotal: 0,
  };
  await createFileWatcher({
    dirs: [dir],
    name: `measure:${dir}`,
    debounceMs: 0,
    onChange: (events) => {
      for (const e of events) state.named.add(e.path);
    },
    onLost: () => {
      state.lost += 1;
      state.lostTotal += 1;
    },
  });
  states.push(state);
}
console.log(
  `watching ${dirs.length} dirs for ${minutes} min, walking every ${everyS}s`,
);

const deadline = Date.now() + minutes * 60_000;
while (Date.now() < deadline) {
  await Bun.sleep(everyS * 1000);
  for (const s of states) {
    // The window's events are those heard since the previous walk BEGAN. An
    // event heard during this walk may be for a change the walk already went
    // past (it surfaces next walk) — so it is checked now and carried over.
    const window = s.named;
    const lostBefore = s.lost;
    s.named = new Set();
    s.lost = 0;
    const { snap, ms } = await snapshot(s.dir);
    s.walks += 1;
    s.walkMs += ms;
    const candidates: string[] = [];
    for (const [p, sig] of snap) if (s.prev.get(p) !== sig) candidates.push(p);
    for (const p of s.prev.keys()) if (!snap.has(p)) candidates.push(p);
    s.moved += candidates.length;
    const isHeard = (p: string): boolean =>
      heard(window, p) || heard(s.named, p);
    // An event for a change that landed just before the walk may still be in
    // flight (FSEvents latency): give it a moment before calling it unheard.
    if (candidates.some((p) => !isHeard(p))) await Bun.sleep(2000);
    if (lostBefore === 0 && s.lost === 0) {
      for (const p of candidates) if (!isHeard(p)) s.unheard.push(p);
    }
    s.prev = snap;
  }
}

for (const s of states) {
  console.log(
    JSON.stringify({
      dir: s.dir,
      walks: s.walks,
      avgWalkMs: Math.round(s.walkMs / Math.max(1, s.walks)),
      filesMoved: s.moved,
      onLost: s.lostTotal,
      unheardChanges: s.unheard.length,
      unheardSample: s.unheard.slice(0, 10),
    }),
  );
}
process.exit(0);
