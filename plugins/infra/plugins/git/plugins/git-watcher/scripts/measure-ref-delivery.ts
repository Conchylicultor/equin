// Measures how late a ref advance is heard: the recursive FSEvents watch of
// `<common>/refs` the git watcher used to hold, against the kqueue follow of
// the tracked ref files it holds now (../server/internal/ref-files.ts), side by
// side on one scratch repo. Each round moves `refs/heads/main` and a nested
// branch (`nested/a/b`, a name with `/`) with `git update-ref` (lockfile +
// rename over the loose ref, as every git command does) and times git's exit →
// the watch hearing the ref's path. Then the edge cases, on the follow only:
// a packed ref deleted (packed-refs rewritten), and the nested dir removed by
// `pack-refs` and re-created by the next advance (a re-plan).
//
//   ./equin run plugins/infra/plugins/git/plugins/git-watcher/scripts/measure-ref-delivery.ts [--rounds 30]
import { mkdtemp, rm } from "node:fs/promises";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchForCommand } from "@plugins/infra/plugins/file-watcher/cli";
import { isDirOnDisk as isDir } from "../server/internal/is-dir";
import { planRefFollow } from "../server/internal/ref-files";

const argv = process.argv.slice(2);
const at = argv.indexOf("--rounds");
const rounds = at >= 0 ? Number(argv[at + 1]) : 30;
const WAIT_MS = 30_000;

// realpath: FSEvents reports /private/var/… for tmpdir()'s /var/….
const root = await realpath(await mkdtemp(join(tmpdir(), "refs-")));
const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
};
git("init", "-q", "-b", "main");
git(
  "-c",
  "user.name=m",
  "-c",
  "user.email=m@m",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "a",
);
const a = git("rev-parse", "HEAD");
git(
  "-c",
  "user.name=m",
  "-c",
  "user.email=m@m",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "b",
);
const b = git("rev-parse", "HEAD");
git("update-ref", "refs/heads/nested/a/b", a);
const common = join(root, ".git");
const REFS = ["refs/heads/main", "refs/heads/nested/a/b"];

type Heard = (paths: string[]) => void;
function waiter() {
  let listeners: Heard[] = [];
  const on: Heard = (paths) => {
    for (const l of listeners) l(paths);
  };
  const next = (path: string): Promise<number> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        listeners = listeners.filter((l) => l !== l2);
        resolve(NaN);
      }, WAIT_MS);
      const l2: Heard = (paths) => {
        if (!paths.includes(path)) return;
        clearTimeout(timer);
        listeners = listeners.filter((l) => l !== l2);
        resolve(performance.now());
      };
      listeners.push(l2);
    });
  return { on, next };
}

const fsev = waiter();
const kq = waiter();
const tree = await watchForCommand({
  name: "measure.refs-tree",
  dirs: [join(common, "refs")],
  debounceMs: 0,
  onChange: (events) => fsev.on(events.map((e) => e.path)),
});
let plan = await planRefFollow(common, REFS, isDir);
let follow = await watchForCommand({
  name: "measure.refs-follow",
  writesWhileOpen: true,
  files: [...plan.files],
  debounceMs: 0,
  onChange: (events) => kq.on(events.map((e) => e.path)),
});

const pct = (xs: number[], p: number) =>
  [...xs].sort((x, y) => x - y)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ]!;
const report = (label: string, xs: number[]) => {
  const ok = xs.filter((x) => !Number.isNaN(x));
  console.log(
    `${label}: heard ${ok.length}/${xs.length}` +
      (ok.length > 0
        ? `, p50 ${pct(ok, 0.5).toFixed(0)} ms, p90 ${pct(ok, 0.9).toFixed(0)} ms, max ${Math.max(...ok).toFixed(0)} ms`
        : ""),
  );
};

const lag = { tree: [] as number[], follow: [] as number[] };
for (let i = 0; i < rounds; i++) {
  const ref = REFS[i % 2]!;
  const path = join(common, ref);
  const hearTree = fsev.next(path);
  const hearFollow = kq.next(path);
  // Every round moves its ref (main starts at b, nested at a): a no-op
  // update-ref writes nothing.
  const t0 = performance.now();
  git(
    "update-ref",
    ref,
    i % 4 < 2 ? (i % 2 === 0 ? a : b) : i % 2 === 0 ? b : a,
  );
  const [t, f] = await Promise.all([hearTree, hearFollow]);
  lag.tree.push(t - t0);
  lag.follow.push(f - t0);
}
report("FSEvents tree watch of refs/ (before)", lag.tree);
report("kqueue follow of the ref files (after)", lag.follow);

// A packed ref deleted: only packed-refs is rewritten.
git("pack-refs", "--all");
const packed = join(common, "packed-refs");
const nestedDir = join(common, "refs/heads/nested");
console.log(`after pack-refs: nested dir present = ${await isDir(nestedDir)}`);
// pack-refs removed the nested dirs: re-plan, as the watcher does on the loss.
plan = await planRefFollow(common, REFS, isDir);
console.log(
  `re-planned follow: ${plan.files.map((f) => f.slice(common.length + 1)).join(", ")}`,
);
const reopened = await watchForCommand({
  name: "measure.refs-follow",
  writesWhileOpen: true,
  files: [...plan.files],
  debounceMs: 0,
  onChange: (events) => kq.on(events.map((e) => e.path)),
});
await follow.stop();
follow = reopened;

const hearDelete = kq.next(packed);
git("update-ref", "-d", "refs/heads/nested/a/b");
let t0 = performance.now();
console.log(
  `packed ref deleted → packed-refs heard after ${((await hearDelete) - t0).toFixed(0)} ms`,
);

// The nested branch re-created: its first missing dir appears (structural).
const firstMissing = [...plan.structural][0]!;
const hearDir = kq.next(firstMissing);
git("update-ref", "refs/heads/nested/a/b", a);
t0 = performance.now();
console.log(
  `nested branch re-created → ${firstMissing.slice(common.length + 1)} heard after ${((await hearDir) - t0).toFixed(0)} ms`,
);

await tree.stop();
await follow.stop();
await rm(root, { recursive: true, force: true });
