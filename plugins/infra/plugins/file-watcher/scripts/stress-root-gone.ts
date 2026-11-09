// Stress: an FSEvents subscription whose root is deleted, unsubscribed the
// moment the batch naming the root arrives — what the engine's subscribeRoot
// and stream pool do. parcel 2.6.0's FSEventsCallback stops the stream itself
// on a deleted root (an fseventsd RPC) before clearing the watcher's state, so
// an unsubscribe landing in that window stops the same stream twice.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/stress-root-gone.ts [--rounds 2000] [--parallel 8]
//
// To widen the window the way a stuck fseventsd does, run it against an addon
// built with a delay before that stop (`usleep(300000)` ahead of the
// callback's `stopStream` on a deleted root), loaded through
// EQUIN_PARCEL_WATCHER_NODE, with MallocScribble=1 MallocGuardEdges=1
// MallocErrorAbort=1 MallocCheckHeapStart=100 MallocCheckHeapEach=100.
// Upstream's FSEvents backend crashed 2 of 3 such runs; the patched one none
// (research/2026-11-09-infra-file-watcher-kqueue-children.md).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParcelWatcher } from "../shared/engine";

const argv = process.argv.slice(2);
const arg = (name: string, d: number): number => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const rounds = arg("--rounds", 2000);
const parallel = arg("--parallel", 8);
const parcel = await getParcelWatcher();
const base = realpathSync(mkdtempSync(join(tmpdir(), "fw-stress-")));
let done = 0;
let heardGone = 0;

async function once(i: number): Promise<void> {
  const dir = join(base, `r${i}`);
  mkdirSync(dir);
  let unsub: Promise<void> | null = null;
  let resolveGone!: () => void;
  const gone = new Promise<void>((r) => (resolveGone = r));
  const sub = await parcel.subscribe(dir, (_err, events) => {
    if (unsub === null && events.some((e) => e.path === dir)) {
      heardGone += 1;
      unsub = sub.unsubscribe();
      resolveGone();
    }
  });
  rmSync(dir, { recursive: true });
  await Promise.race([gone, Bun.sleep(3000)]);
  await (unsub ?? sub.unsubscribe());
  done += 1;
}

const t0 = performance.now();
for (let i = 0; i < rounds; i += parallel) {
  await Promise.all(
    Array.from({ length: Math.min(parallel, rounds - i) }, (_, k) =>
      once(i + k),
    ),
  );
}
console.log(
  `${done} rounds, root delete heard in ${heardGone}, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);
rmSync(base, { recursive: true, force: true });
