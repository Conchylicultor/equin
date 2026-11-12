// Measures a `children` watch on parcel's kqueue backend (macOS) against the
// FSEvents one: what opening it costs on `/`, `~` and a scratch dir, how many
// descriptors it holds, and whether every entry change is heard — plain
// writes, atomic rename-over writes (write a staging sibling, rename it over
// the target), creates and deletes — and how late.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/measure-kqueue-children.ts [--rounds 50]
//   ./equin run …/measure-kqueue-children.ts --sizes   # kqueue open cost and descriptors by dir size
//
// Research: research/2026-11-09-infra-file-watcher-kqueue-children.md
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { join } from "node:path";
import { createFileWatcher, fsEventsStreams } from "../shared/engine";
import { getParcelWatcher } from "../shared/engine";
import { KQUEUE_CHILDREN_DEPTH } from "../shared/kqueue-children";
import type { FileChangeEvent } from "../shared/registry";

const argv = process.argv.slice(2);
const at = argv.indexOf("--rounds");
const rounds = at >= 0 ? Number(argv[at + 1]) : 50;

function descriptorsUnder(root: string): number {
  const out = Bun.spawnSync(["lsof", "-p", String(process.pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return out.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes(root)).length;
}

const pct = (xs: number[], p: number): number =>
  xs.length === 0
    ? NaN
    : [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.floor(xs.length * p))
      ]!;

async function openCost(dir: string): Promise<void> {
  const t0 = performance.now();
  const w = await createFileWatcher({
    dirs: [dir],
    depth: "children",
    debounceMs: 0,
    onChange: () => {},
  });
  const ms = performance.now() - t0;
  console.log(
    `open ${dir}: ${ms.toFixed(1)} ms, streams ${fsEventsStreams().open.length}`,
  );
  await w.stop();
}

async function heardLag(): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fw-kq-")));
  const heard: { at: number; e: FileChangeEvent }[] = [];
  const w = await createFileWatcher({
    dirs: [dir],
    depth: "children",
    debounceMs: 0,
    onChange: (batch) => {
      const now = performance.now();
      for (const e of batch) heard.push({ at: now, e });
    },
  });
  console.log(`descriptors under ${dir}: ${descriptorsUnder(dir)}`);
  const lags: Record<string, number[]> = {
    write: [],
    rename: [],
    create: [],
    delete: [],
  };
  const missed: Record<string, number> = {
    write: 0,
    rename: 0,
    create: 0,
    delete: 0,
  };
  const target = join(dir, "status.json");
  await writeFile(target, "0");
  const waitFor = async (
    kind: string,
    since: number,
    match: (e: FileChangeEvent) => boolean,
  ): Promise<void> => {
    for (let i = 0; i < 3000; i++) {
      const hit = heard.find((h) => h.at >= since && match(h.e));
      if (hit) {
        lags[kind]!.push(hit.at - since);
        return;
      }
      await Bun.sleep(10);
    }
    missed[kind]! += 1;
  };
  for (let i = 0; i < rounds; i++) {
    let t = performance.now();
    await writeFile(target, `w${i}`);
    await waitFor("write", t, (e) => e.path === target);
    t = performance.now();
    const staging = join(dir, `.status.json.${i}.tmp`);
    await writeFile(staging, `r${i}`);
    await rename(staging, target);
    await waitFor("rename", t, (e) => e.path === target);
    const f = join(dir, `f${i}`);
    t = performance.now();
    await writeFile(f, "x");
    await waitFor("create", t, (e) => e.path === f && e.type === "create");
    t = performance.now();
    await unlink(f);
    await waitFor("delete", t, (e) => e.path === f && e.type === "delete");
  }
  for (const kind of Object.keys(lags)) {
    const xs = lags[kind]!;
    console.log(
      `${kind}: heard ${xs.length}/${rounds}, missed ${missed[kind]}, p50 ${pct(xs, 0.5).toFixed(1)} ms, max ${pct(xs, 1).toFixed(1)} ms`,
    );
  }
  console.log(`descriptors under ${dir} after: ${descriptorsUnder(dir)}`);
  await w.stop();
  console.log(`descriptors under ${dir} stopped: ${descriptorsUnder(dir)}`);
  await rm(dir, { recursive: true, force: true });
}

/**
 * What a kqueue children watch costs by dir size, the budget's question:
 * the open (parcel lists the dir and every entry folder, and opens one
 * descriptor per entry) and the descriptors held. Opened on the native kqueue
 * subscription directly, past the engine's budget. A dir of plain files, and
 * one of folders each holding 64 files (whose listings the open reads too).
 */
async function sizes(): Promise<void> {
  const parcel = await getParcelWatcher();
  for (const shape of ["files", "folders"] as const) {
    for (const n of [16, 64, 256, 1024, 4096]) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "fw-kq-size-")));
      for (let i = 0; i < n; i++) {
        if (shape === "files") await writeFile(join(dir, `f${i}`), "");
        else {
          await mkdir(join(dir, `d${i}`));
          if (i < 64)
            for (let j = 0; j < 64; j++)
              await writeFile(join(dir, `d${i}`, `g${j}`), "");
        }
      }
      const opens: number[] = [];
      let held = 0;
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        const sub = await parcel.subscribe(dir, () => {}, {
          backend: "kqueue",
          depth: KQUEUE_CHILDREN_DEPTH,
        });
        opens.push(performance.now() - t0);
        if (r === 0) held = descriptorsUnder(dir);
        await sub.unsubscribe();
      }
      console.log(
        `${shape} ${n}: open p50 ${pct(opens, 0.5).toFixed(1)} ms, max ${pct(opens, 1).toFixed(1)} ms, descriptors ${held}`,
      );
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (argv.includes("--sizes")) {
  await sizes();
} else {
  await openCost("/");
  await openCost(HOME_DIR);
  await heardLag();
}
