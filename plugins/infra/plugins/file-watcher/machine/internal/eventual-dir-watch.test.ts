import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirWatchRequest, FileChangeEvent } from "../../server";
import { WatchedDirGoneError } from "../../shared/engine";
import { acquireEventualDirWatchWith } from "./eventual-dir-watch";

/** A fake hub: one held watch per dir. */
function fakeAcquire() {
  const held = new Map<string, DirWatchRequest>();
  const acquire = async (request: DirWatchRequest) => {
    held.set(request.dir, request);
    return () => {
      held.delete(request.dir);
    };
  };
  /** Fire `events` at whoever holds `dir`, and wait for its reaction. */
  const emit = async (dir: string, events: FileChangeEvent[]) => {
    await held.get(dir)!.onChange(events);
  };
  return { acquire, held, emit };
}

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eventual-dir-watch-")));
  const dir = join(root, "wt");
  const fake = fakeAcquire();
  const seen: FileChangeEvent[] = [];
  const request: DirWatchRequest = {
    dir,
    scope: "children",
    onChange: (events) => {
      seen.push(...events);
    },
  };
  return { dir, fake, seen, request };
}

describe("acquireEventualDirWatchWith", () => {
  test("a missing dir resolves holding only its parent, and opens when it appears", async () => {
    const { dir, fake, seen, request } = setup();
    const release = await acquireEventualDirWatchWith(fake.acquire, request);
    expect([...fake.held.keys()]).toEqual([root]);

    mkdirSync(dir);
    await fake.emit(root, [{ type: "create", path: dir }]);
    expect([...fake.held.keys()].sort()).toEqual([root, dir].sort());
    expect(seen).toEqual([{ type: "create", path: dir }]);

    await fake.emit(dir, [{ type: "create", path: join(dir, "f") }]);
    expect(seen.at(-1)).toEqual({ type: "create", path: join(dir, "f") });

    release();
    expect(fake.held.size).toBe(0);
  });

  test("a dir removed drops its watch and reports the delete", async () => {
    const { dir, fake, seen, request } = setup();
    mkdirSync(dir);
    const release = await acquireEventualDirWatchWith(fake.acquire, request);
    expect(fake.held.has(dir)).toBe(true);

    rmSync(dir, { recursive: true });
    await fake.emit(root, [{ type: "delete", path: dir }]);
    expect(fake.held.has(dir)).toBe(false);
    expect(seen).toEqual([{ type: "delete", path: dir }]);
    release();
  });

  test("a parent event for another entry opens nothing", async () => {
    const { dir, fake, seen, request } = setup();
    const release = await acquireEventualDirWatchWith(fake.acquire, request);
    mkdirSync(join(root, "other"));
    await fake.emit(root, [{ type: "create", path: join(root, "other") }]);
    expect(fake.held.has(dir)).toBe(false);
    expect(seen).toEqual([]);
    release();
  });

  test("a missing parent rejects, holding nothing", async () => {
    const { fake, request } = setup();
    const acquire = async (r: DirWatchRequest) => {
      throw new Error(`ENOENT ${r.dir}`);
    };
    let caught: unknown = null;
    try {
      await acquireEventualDirWatchWith(acquire, {
        ...request,
        dir: join(root, "nope", "wt"),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(fake.held.size).toBe(0);
  });
});

describe("the dir's own watch reporting its dir gone", () => {
  test("re-opens it, even when the folder now there has the same inode", async () => {
    const { dir, fake, seen, request } = setup();
    mkdirSync(dir);
    let opens = 0;
    const acquire = async (r: DirWatchRequest) => {
      if (r.dir === dir) opens++;
      return fake.acquire(r);
    };
    const lost: unknown[] = [];
    const release = await acquireEventualDirWatchWith(acquire, {
      ...request,
      onLost: (e) => void lost.push(e),
    });
    expect(opens).toBe(1);

    // The engine closed the dir's watch (it saw the dir go); by the time the
    // re-sync stats the path a folder is back there — same inode or not, the
    // dead watch must not be kept.
    const gone = new WatchedDirGoneError(dir);
    fake.held.get(dir)!.onLost!(gone);
    for (let i = 0; i < 100 && opens < 2; i++) await Bun.sleep(5);
    expect(opens).toBe(2);
    expect(fake.held.has(dir)).toBe(true);
    expect(seen).toEqual([
      { type: "delete", path: dir },
      { type: "create", path: dir },
    ]);
    expect(lost).toEqual([gone]);
    release();
    expect(fake.held.size).toBe(0);
  });
});
