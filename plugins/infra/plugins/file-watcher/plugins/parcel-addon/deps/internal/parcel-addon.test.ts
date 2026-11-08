import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type * as parcel from "@parcel/watcher";
import { createWrapper } from "@parcel/watcher/wrapper";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { builtFile } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { parcelWatcherAddon } from "./parcel-addon";

// The patched addon, loaded on its own (not through the checkout's
// `build/Release` copy, which only `./equin build` writes), under kqueue: every
// descriptor a watch took is given back when what it watched goes. Upstream
// 2.6.0 kept them for the life of the process — a followed file deleted or
// renamed, the entries of a watched directory that went, and a path two
// overlapping watches both held.

const N = 40;
const KQUEUE = { backend: "kqueue" as parcel.BackendType }; // the binding takes it; the published type leaves it out
const dirs: string[] = [];
/** Errors a watch reported: asserted empty at each test's end, never thrown off-thread. */
const watchErrors: Error[] = [];
let watcher: typeof parcel;
let warm: parcel.AsyncSubscription;

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `parcel-addon-${prefix}-`));
  dirs.push(dir);
  return dir;
};

/**
 * The ignore the file-watcher engine follows named files with
 * (`shared/follow-files.ts`' `onlyNames`): everything but these direct entries.
 */
const onlyNames = (names: string[]): RegExp =>
  new RegExp(
    `^(?!(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$)`,
  );

/** This process's open descriptors. */
const openFds = (): number => readdirSync("/dev/fd").length;

/** Resolves once `seen()` holds, or rejects naming what it waited for. */
function until(seen: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (seen()) return resolve();
      if (Date.now() - start > ms)
        return reject(new Error(`timed out: ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Waits up to 5 s for the descriptor count to reach `base + held`, then asserts it. */
async function expectHeld(base: number, held: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (openFds() - base !== held && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(openFds() - base).toBe(held);
}

/** A kqueue subscription recording its events; its errors go to `watchErrors`. */
async function subscribe(
  dir: string,
  opts: parcel.Options = {},
): Promise<{ sub: parcel.AsyncSubscription; events: parcel.Event[] }> {
  const events: parcel.Event[] = [];
  const sub = await watcher.subscribe(
    dir,
    (err, batch) => {
      if (err) watchErrors.push(err);
      events.push(...batch);
    },
    { ...KQUEUE, ...opts },
  );
  return { sub, events };
}

describe.skipIf(process.platform !== "darwin")(
  "parcel-watcher-addon (kqueue)",
  () => {
    beforeAll(async () => {
      const ready = await ensureDep(parcelWatcherAddon, execContextForTests());
      watcher = createWrapper(
        createRequire(import.meta.url)(builtFile(ready)),
      ) as typeof parcel;
      // The backend holds its own kqueue and wake-up pipe while any
      // subscription is open: hold one of an empty dir throughout, so every
      // baseline includes them.
      warm = await watcher.subscribe(tempDir("warm"), () => undefined, KQUEUE);
    }, 15 * 60_000);
    afterAll(async () => {
      await warm.unsubscribe();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    test("a followed file deleted or renamed closes its descriptor", async () => {
      const dir = tempDir("follow");
      const names = Array.from({ length: N }, (_, i) => `f${i}.jsonl`);
      for (const n of names) writeFileSync(join(dir, n), "x\n");

      const base = openFds();
      // The engine's `writesWhileOpen` shape: only the named files.
      const { sub, events } = await subscribe(dir, {
        ignore: [onlyNames(names)],
      });
      // One per named file, plus the directory's.
      await expectHeld(base, N + 1);

      appendFileSync(join(dir, names[0]!), "y\n");
      await until(
        () => events.some((e) => e.type === "update"),
        5_000,
        "a write to a followed file",
      );

      for (const [i, n] of names.entries()) {
        if (i % 2) unlinkSync(join(dir, n));
        else renameSync(join(dir, n), join(dir, `${n}.old`));
      }
      await until(
        () => events.filter((e) => e.type === "delete").length === N,
        5_000,
        "every followed file reported gone",
      );
      // Only the directory's descriptor is left.
      await expectHeld(base, 1);

      // The names come back: followed again, one descriptor each.
      for (const n of names) writeFileSync(join(dir, n), "z\n");
      await until(
        () => events.filter((e) => e.type === "create").length === N,
        5_000,
        "every recreated file heard",
      );
      await expectHeld(base, N + 1);

      await sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    });

    test("a watched directory renamed away or deleted closes its entries' descriptors", async () => {
      const dir = tempDir("tree");
      for (const s of ["moved", "removed"]) {
        mkdirSync(join(dir, s));
        for (let i = 0; i < 10; i++) writeFileSync(join(dir, s, `f${i}`), "x");
      }
      const away = join(tempDir("away"), "moved");

      const base = openFds();
      const { sub } = await subscribe(dir);
      // The root, two directories, twenty files.
      await expectHeld(base, 23);

      renameSync(join(dir, "moved"), away);
      rmSync(join(dir, "removed"), { recursive: true });
      await expectHeld(base, 1);

      await sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    });

    test("a removed directory's entries are reported deleted, and one recreated is watched afresh", async () => {
      const dir = tempDir("events");
      mkdirSync(join(dir, "s"));
      for (let i = 0; i < 5; i++) writeFileSync(join(dir, "s", `f${i}`), "x");

      const base = openFds();
      const { sub, events } = await subscribe(dir);
      const seen = (type: string, rel: string): boolean =>
        events.some((e) => e.type === type && e.path === join(dir, rel));

      rmSync(join(dir, "s"), { recursive: true });
      const gone = ["s", ...Array.from({ length: 5 }, (_, i) => `s/f${i}`)];
      await until(
        () => gone.every((rel) => seen("delete", rel)),
        5_000,
        "the directory and each of its entries reported deleted",
      );
      await expectHeld(base, 1);

      mkdirSync(join(dir, "s"));
      await until(() => seen("create", "s"), 5_000, "the directory recreated");
      writeFileSync(join(dir, "s", "g"), "y");
      await until(() => seen("create", "s/g"), 5_000, "a file in it created");
      appendFileSync(join(dir, "s", "g"), "z");
      await until(() => seen("update", "s/g"), 5_000, "a write to it heard");
      await expectHeld(base, 3);

      await sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    });

    test("a path two nested watches both hold closes both descriptors", async () => {
      const dir = tempDir("nested");
      const inner = join(dir, "inner");
      mkdirSync(inner);
      for (let i = 0; i < 10; i++) writeFileSync(join(inner, `f${i}`), "x");

      const base = openFds();
      // Two trees: the outer holds root + inner + ten files, the inner its
      // own inner + ten files.
      const outer = await subscribe(dir);
      const nested = await subscribe(inner);
      await expectHeld(base, 23);

      for (let i = 0; i < 10; i++) unlinkSync(join(inner, `f${i}`));
      await expectHeld(base, 3);

      await nested.sub.unsubscribe();
      await outer.sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    });
    test("a subscribe that fails holds nothing, and the next one of the directory opens", async () => {
      const dir = tempDir("rollback");
      // Many names, so the failing one is rarely the first the open reaches.
      const names = Array.from({ length: 200 }, (_, i) => `f${i}.log`);
      for (const n of names) writeFileSync(join(dir, n), "x\n");
      // A followed name no descriptor can be opened on: a symlink to itself.
      symlinkSync("loop", join(dir, "loop"));

      const base = openFds();
      // Upstream left the subscriptions it had made before the failure in the
      // backend — their descriptors, and the directory's cached listing, held
      // for the life of the process; every later subscription of the directory
      // reused that listing, met an entry its own ignore excludes and failed
      // with whatever errno the thread last held.
      expect(
        subscribe(dir, { ignore: [onlyNames([...names, "loop"])] }),
      ).rejects.toThrow(/Too many levels of symbolic links/);
      await expectHeld(base, 0);

      const other = Array.from({ length: 5 }, (_, i) => `g${i}.log`);
      for (const n of other) writeFileSync(join(dir, n), "x\n");
      const { sub, events } = await subscribe(dir, {
        ignore: [onlyNames(other)],
      });
      await expectHeld(base, other.length + 1);
      appendFileSync(join(dir, other[0]!), "y\n");
      await until(
        () => events.some((e) => e.path === join(dir, other[0]!)),
        5_000,
        "a write to a followed file",
      );
      await sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    }, 30_000);

    test("subscriptions of one directory with different ignores each see exactly their own files", async () => {
      const dir = tempDir("shared");
      const a = ["a0.log", "a1.log"];
      const b = ["b0.log", "b1.log"];
      for (const n of [...a, ...b]) writeFileSync(join(dir, n), "x\n");

      const base = openFds();
      // Upstream shared one cached listing per directory between them, read
      // through the FIRST one's ignore: the second failed outright (`error
      // watching <dir>: Undefined error: 0`) or missed its files.
      const first = await subscribe(dir, { ignore: [onlyNames(a)] });
      const second = await subscribe(dir, { ignore: [onlyNames(b)] });
      await expectHeld(base, a.length + b.length + 2);

      for (const n of [...a, ...b]) appendFileSync(join(dir, n), "y\n");
      const paths = (events: parcel.Event[]): string[] =>
        [...new Set(events.map((e) => e.path))].sort();
      await until(
        () =>
          paths(first.events).length === a.length &&
          paths(second.events).length === b.length,
        5_000,
        "each subscription hearing its own files",
      );
      expect(paths(first.events)).toEqual(a.map((n) => join(dir, n)));
      expect(paths(second.events)).toEqual(b.map((n) => join(dir, n)));

      await first.sub.unsubscribe();
      await second.sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    });

    test("re-opening a follow while its directory keeps changing never fails", async () => {
      const dir = tempDir("churn");
      // The runs dir's size on main: every diff of it is a long readdir.
      for (let i = 0; i < 1_200; i++)
        writeFileSync(join(dir, `old-${i}.log`), "");
      const base = openFds();
      // The supervised runs dir under a burst of starts: other processes
      // create and delete entries the follow does not name while it is
      // re-opened over a changing set of names. Upstream's event thread diffed
      // the directory into the subscription's cached listing — unignored
      // entries included — while `subscribe` iterated it on another thread:
      // the open met an entry it ignores and failed with a stale errno
      // ("File exists", "No such file or directory", "Undefined error: 0").
      const writer = spawn(
        "/bin/sh",
        [
          "-c",
          `cd ${JSON.stringify(dir)} && i=0; while :; do i=$((i+1)); : > other-$i.log; rm -f other-$((i-40)).log; done`,
        ],
        { stdio: "ignore" },
      );
      try {
        for (let round = 0; round < 150; round++) {
          const names = Array.from(
            { length: 1 + (round % 7) },
            (_, i) => `run-${round}-${i}.log`,
          );
          for (const n of names) writeFileSync(join(dir, n), "x\n");
          const { sub } = await subscribe(dir, { ignore: [onlyNames(names)] });
          await sub.unsubscribe();
        }
      } finally {
        writer.kill("SIGKILL");
      }
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    }, 60_000);
  },
);
