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
import { execFileSync, spawn } from "node:child_process";
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

    test("an entry kqueue cannot watch (socket, FIFO, dangling symlink) is listed with no descriptor, at open and when created", async () => {
      const dir = tempDir("kinds");
      // A socket file left by another process (bound, never unlinked), so no
      // listening descriptor of this one is counted.
      const bindSocket = (path: string): void => {
        execFileSync(process.execPath, [
          "-e",
          `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
        ]);
      };
      bindSocket(join(dir, "a.sock"));
      execFileSync("mkfifo", [join(dir, "a.fifo")]);
      symlinkSync(join(dir, "nowhere"), join(dir, "a.dangling"));
      writeFileSync(join(dir, "f"), "x");

      const base = openFds();
      // Upstream (and the patch before it) opened every entry: the socket
      // failed the whole subscribe ("Operation not supported on socket").
      const { sub, events } = await subscribe(dir);
      const seen = (type: string, rel: string): boolean =>
        events.some((e) => e.type === type && e.path === join(dir, rel));
      await expectHeld(base, 2); // the dir and `f`

      // Created while watched, in one diff with a file: the file after them is
      // still created and watched (a failed entry used to end the diff).
      bindSocket(join(dir, "b.sock"));
      execFileSync("mkfifo", [join(dir, "b.fifo")]);
      writeFileSync(join(dir, "g"), "y");
      await until(
        () => ["b.sock", "b.fifo", "g"].every((rel) => seen("create", rel)),
        5_000,
        "the socket, the FIFO and the file created",
      );
      appendFileSync(join(dir, "g"), "z");
      await until(
        () => seen("update", "g"),
        5_000,
        "a write to the file heard",
      );
      await expectHeld(base, 3);

      for (const name of [
        "a.sock",
        "b.sock",
        "a.fifo",
        "b.fifo",
        "a.dangling",
      ]) {
        rmSync(join(dir, name), { force: true });
      }
      await until(
        () =>
          ["a.sock", "b.sock", "a.fifo", "b.fifo", "a.dangling"].every((rel) =>
            seen("delete", rel),
          ),
        5_000,
        "each of them reported deleted",
      );

      await sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    }, 30_000);

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
    test("a folder removed from an outer watch leaves the watches rooted below it whole", async () => {
      // A removal erased every subscription of each path it removed — those
      // of a separate watch rooted there included, whose tree is not the
      // remover's. Renaming an ancestor away is heard by the outer watch
      // alone (the inner roots' own vnodes stay), so it is deterministic:
      // the inner watches lost every subscription, their descriptors stayed
      // open past their unsubscribe, and a later delete of their root
      // found no subscription to report to.
      const dir = tempDir("rooted");
      const mid = join(dir, "parent", "mid");
      const deep = join(mid, "deep");
      mkdirSync(deep, { recursive: true });
      for (let i = 0; i < 5; i++) writeFileSync(join(deep, `f${i}`), "x");
      const away = join(tempDir("rooted-away"), "parent");

      const base = openFds();
      // The outer: root, parent, mid, deep, five files.
      const outer = await subscribe(dir);
      // Rooted at mid (mid, deep, five files) and at deep (deep, five files).
      const atMid = await subscribe(mid);
      const atDeep = await subscribe(deep);
      await expectHeld(base, 9 + 7 + 6);

      renameSync(join(dir, "parent"), away);
      await until(
        () => outer.events.some((e) => e.type === "delete" && e.path === deep),
        5_000,
        "the outer watch hearing the folder and its entries gone",
      );
      // The outer holds its root; the inner watches are untouched.
      await expectHeld(base, 1 + 7 + 6);

      await atDeep.sub.unsubscribe();
      await expectHeld(base, 1 + 7);

      // The path comes back as other folders, which the outer watch follows
      // while the watch rooted at mid still watches the folder moved away.
      const seenByOuter = (type: string, path: string): boolean =>
        outer.events.some((e) => e.type === type && e.path === path);
      mkdirSync(join(dir, "parent"));
      await until(
        () => seenByOuter("create", join(dir, "parent")),
        5_000,
        "parent recreated",
      );
      mkdirSync(mid);
      await until(() => seenByOuter("create", mid), 5_000, "mid recreated");
      await expectHeld(base, 3 + 7);
      const outerDeletes = (): number =>
        outer.events.filter((e) => e.type === "delete").length;
      const deletesBefore = outerDeletes();

      // The watch rooted at mid hears its own root go, by the path it was
      // opened with; the outer watch's folder at that path is not touched.
      rmSync(away, { recursive: true });
      await until(
        () => atMid.events.some((e) => e.type === "delete" && e.path === mid),
        5_000,
        "the watch rooted at mid hearing its root deleted",
      );
      await expectHeld(base, 3);
      expect(outerDeletes()).toBe(deletesBefore);
      writeFileSync(join(mid, "new"), "x");
      await until(
        () => seenByOuter("create", join(mid, "new")),
        5_000,
        "the outer watch still following the recreated mid",
      );
      await expectHeld(base, 4);

      await atMid.sub.unsubscribe();
      await outer.sub.unsubscribe();
      await expectHeld(base, 0);
      expect(watchErrors).toEqual([]);
    }, 30_000);

    test("a subscribe that fails holds nothing, and the next one of the directory opens", async () => {
      // Upstream left the subscriptions it had made before the failure in the
      // backend — their descriptors, and the directory's cached listing, held
      // for the life of the process; every later subscription of the directory
      // reused that listing, met an entry its own ignore excludes and failed
      // with whatever errno the thread last held. The failure here is the
      // process's descriptor limit (EMFILE) partway through 200 files — in a
      // child, whose limit is lowered alone; every kind of entry kqueue cannot
      // watch is listed instead of failing the subscribe (test above).
      const ready = await ensureDep(parcelWatcherAddon, execContextForTests());
      const warmDir = tempDir("rollback-warm");
      const dir = tempDir("rollback");
      const names = Array.from({ length: 200 }, (_, i) => `f${i}.log`);
      for (const n of names) writeFileSync(join(dir, n), "x\n");
      const other = Array.from({ length: 5 }, (_, i) => `g${i}.log`);
      for (const n of other) writeFileSync(join(dir, n), "x\n");
      const script = `
        const [wrapperPath, addonPath, warmDir, dir, followed, ignore] = process.argv.slice(-6);
        const { appendFileSync, readdirSync } = require("node:fs");
        const { join } = require("node:path");
        const addon = require(wrapperPath).createWrapper(require(addonPath));
        const fds = () => readdirSync("/dev/fd").length;
        // The backend's own kqueue and pipe, in the baseline.
        const warm = await addon.subscribe(warmDir, () => {}, { backend: "kqueue" });
        const base = fds();
        const failed = await addon.subscribe(dir, () => {}, { backend: "kqueue" }).then(
          () => "resolved",
          (err) => err.message,
        );
        const heldAfterFailure = fds() - base;
        const events = [];
        const sub = await addon.subscribe(dir, (err, batch) => {
          if (err) throw err;
          events.push(...batch);
        }, { backend: "kqueue", ignore: [new RegExp(ignore)] });
        const heldByNext = fds() - base;
        appendFileSync(join(dir, followed), "y");
        const start = Date.now();
        while (!events.some((e) => e.path === join(dir, followed)) && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const heard = events.some((e) => e.path === join(dir, followed));
        await sub.unsubscribe();
        const heldAtEnd = fds() - base;
        await warm.unsubscribe();
        console.log(JSON.stringify({ failed, heldAfterFailure, heldByNext, heard, heldAtEnd }));
        process.exit(0);`;
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          // Room for bun and the 5 followed files, none for the 200: set
          // above what the child inherits (a test runner holds many).
          'ulimit -n $(( $(ls /dev/fd | wc -l) + 80 )) && exec "$0" -e "$1" "$2" "$3" "$4" "$5" "$6" "$7"',
          process.execPath,
          script,
          createRequire(import.meta.url).resolve("@parcel/watcher/wrapper"),
          builtFile(ready),
          warmDir,
          dir,
          other[0]!,
          onlyNames(other).source,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
      const code = await new Promise<number | null>((resolve) =>
        child.on("exit", (c) => resolve(c)),
      );
      expect({ code, err }).toEqual({ code: 0, err: "" });
      const result = JSON.parse(out) as Record<string, unknown>;
      expect(result.failed).toMatch(/Too many open files/);
      expect(result).toMatchObject({
        heldAfterFailure: 0,
        heldByNext: other.length + 1,
        heard: true,
        heldAtEnd: 0,
      });
    }, 60_000);

    test("a folder diff that cannot watch a created entry reports every create and the loss", async () => {
      // Upstream's diff stopped at the first entry it could not watch and
      // start() ignored its answer: the rest of the diff (other creates,
      // every delete) went unreported, with no error, until the folder
      // changed again. The failure here is EMFILE once the diff has its
      // folder open — in a child, whose descriptors are used up alone: every
      // descriptor but one is taken, the files are renamed in (no descriptor
      // needed), and the diff's dup takes the last, so each open fails.
      const ready = await ensureDep(parcelWatcherAddon, execContextForTests());
      const dir = tempDir("diff-fails");
      const staging = tempDir("diff-fails-staging");
      const names = ["a.log", "b.log", "c.log"];
      const script = `
        const [wrapperPath, addonPath, dir, staging, names] = process.argv.slice(-5);
        const { closeSync, openSync, renameSync, writeFileSync } = require("node:fs");
        const { join } = require("node:path");
        const addon = require(wrapperPath).createWrapper(require(addonPath));
        const events = [];
        const errors = [];
        const sub = await addon.subscribe(dir, (err, batch) => {
          if (err) errors.push(err.message);
          events.push(...batch);
        }, { backend: "kqueue" });
        const files = names.split(",");
        for (const n of files) writeFileSync(join(staging, n), "x");
        const fillers = [];
        while (true) {
          try { fillers.push(openSync("/dev/null", "r")); }
          catch (err) { if (err.code === "EMFILE") break; throw err; }
        }
        closeSync(fillers.pop());
        for (const n of files) renameSync(join(staging, n), join(dir, n));
        const start = Date.now();
        while (errors.length === 0 && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 300));
        for (const fd of fillers) closeSync(fd);
        await sub.unsubscribe();
        const created = [...new Set(events.filter((e) => e.type === "create").map((e) => e.path))].sort();
        console.log(JSON.stringify({ created, errors }));
        process.exit(0);`;
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'ulimit -n $(( $(ls /dev/fd | wc -l) + 80 )) && exec "$0" -e "$1" "$2" "$3" "$4" "$5" "$6"',
          process.execPath,
          script,
          createRequire(import.meta.url).resolve("@parcel/watcher/wrapper"),
          builtFile(ready),
          dir,
          staging,
          names.join(","),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
      const code = await new Promise<number | null>((resolve) =>
        child.on("exit", (c) => resolve(c)),
      );
      expect({ code, err }).toEqual({ code: 0, err: "" });
      const result = JSON.parse(out) as { created: string[]; errors: string[] };
      expect(result.created).toEqual(names.map((n) => join(dir, n)));
      expect(result.errors.length).toBeGreaterThan(0);
      for (const message of result.errors)
        expect(message).toMatch(
          /^error diffing .*: watch .*: Too many open files$/,
        );
    }, 60_000);

    test("an entry gone between a folder's listing and its open is no loss", async () => {
      // The vanished-entry race is expected, not a failure: an entry created
      // and removed while its folder is diffed is skipped (its create and
      // removal cancel out), and the diff goes on — every lasting file heard,
      // no error reported.
      const dir = tempDir("vanish");
      const { sub, events } = await subscribe(dir);
      const churn = spawn(
        "/bin/sh",
        [
          "-c",
          `cd ${JSON.stringify(dir)} && i=0; while :; do i=$((i+1)); : > tmp-$i; mkdir d-$i; rm -f tmp-$i; rmdir d-$i; done`,
        ],
        { stdio: "ignore" },
      );
      const kept = Array.from({ length: 100 }, (_, i) => `keep-${i}.log`);
      try {
        for (const n of kept) {
          writeFileSync(join(dir, n), "x");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const heard = (): number =>
          new Set(
            events
              .filter((e) => e.type === "create" && e.path.includes("/keep-"))
              .map((e) => e.path),
          ).size;
        await until(() => heard() === kept.length, 10_000, "every kept file");
      } finally {
        churn.kill("SIGKILL");
      }
      await sub.unsubscribe();
      expect(watchErrors).toEqual([]);
    }, 60_000);

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

    test("beside upstream's prebuild in one process, a subscribe that fails rejects in either load order", async () => {
      // A test run that covers the engine and this file loads both: the
      // engine's `@parcel/watcher` (the prebuild, in a checkout `./equin
      // build` never linked) and the built file above. Built with default
      // visibility, the two exported the same weak C++ definitions and dyld
      // bound one image's async work to the other's `PromiseRunner::onExecute`:
      // the failed subscribe's rethrow found no handler and the process died
      // of SIGABRT. In a child, since that kills whoever runs it.
      const ready = await ensureDep(parcelWatcherAddon, execContextForTests());
      const prebuild = createRequire(
        createRequire(import.meta.url).resolve("@parcel/watcher/package.json"),
      ).resolve(`@parcel/watcher-darwin-${process.arch}`);
      const missing = join(tempDir("two-images"), "missing");
      const script = `
        const [first, second, dir] = process.argv.slice(-3);
        require(first);
        const addon = require(second);
        for (const backend of ["kqueue", "fs-events"]) {
          await addon.subscribe(dir, () => {}, { backend }).then(
            () => console.log(backend, "resolved"),
            () => console.log(backend, "rejected"),
          );
        }`;
      for (const [first, second] of [
        [prebuild, builtFile(ready)],
        [builtFile(ready), prebuild],
      ]) {
        const child = spawn(
          process.execPath,
          ["-e", script, first!, second!, missing],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
        const exit = await new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve) =>
          child.on("exit", (code, signal) => resolve({ code, signal })),
        );
        expect({ exit, out, err }).toEqual({
          exit: { code: 0, signal: null },
          out: "kqueue rejected\nfs-events rejected\n",
          err: "",
        });
      }
    }, 60_000);
  },
);
