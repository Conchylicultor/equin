/**
 * host-fs's live values, against a real temp folder: the listing's pages hold
 * the paged-source contract over every range (`checkPagedSource`) and its meta
 * says what the endpoint said beside the entries; every failure the endpoints
 * answered as a result kind is the read's declared refusal; and
 * `watchHostDir` / `watchHostPath` (over fake dir watches) hear a folder's
 * entries change, a folder (or a file's folder) created after the watch
 * opened, a symlink's target, and retry a re-arm that failed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DirWatchRequest } from "@plugins/infra/plugins/file-watcher/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import { hostFsListing, type HostFsEntry } from "../../core";
import { listHostDir } from "../../server/internal/list";
import { dirPeek, listingMeta, listingPage } from "./listing";
import {
  hostFsFileTextServed,
  hostFsPathStatServed,
  hostFsVolumeInfoServed,
} from "./reads";
import { watchHostPathOver } from "./version";
import { watchHostDirOver, type AcquireDirWatch } from "./watch-dir";

let root: string;

beforeAll(() => {
  // Real path: the watch hub names paths as the filesystem reports them.
  root = realpathSync(mkdtempSync(join(tmpdir(), "host-fs-live-test-")));
  for (const name of ["b.txt", "A.txt", "c10.txt", "c9.txt", ".hidden"]) {
    writeFileSync(join(root, name), name);
  }
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The code of the refusal `p` rejects with. */
async function refusalCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error("expected a refusal");
}

describe("host-fs.list", () => {
  test("pages hold the paged-source contract over every range", async () => {
    const listed = await listHostDir(root);
    if (listed.kind !== "ok") throw new Error(listed.kind);
    await checkPagedSource<HostFsEntry, { path?: string }>({
      value: hostFsListing,
      query: { path: root },
      loader: listingPage,
      items: listed.entries,
      limits: [1, 3, 500],
    });
  });

  test("a page is in code-point name order", async () => {
    const page = await listingPage(
      { path: root },
      { after: null, until: null, limit: 500 },
    );
    expect(page.map((e) => e.name)).toEqual([
      ".hidden",
      "A.txt",
      "b.txt",
      "binary.bin",
      "c10.txt",
      "c9.txt",
      "sub",
    ]);
  });

  test("the meta says what the folder is", async () => {
    expect(await listingMeta({ path: root })).toEqual({
      path: root,
      parent: join(root, ".."),
      total: 7,
    });
  });

  test("failures are refusals", async () => {
    expect(await refusalCode(listingMeta({ path: join(root, "nope") }))).toBe(
      "missing",
    );
    expect(await refusalCode(listingMeta({ path: join(root, "b.txt") }))).toBe(
      "not-a-dir",
    );
    expect(await refusalCode(listingMeta({ path: "relative" }))).toBe(
      "invalid-path",
    );
  });
});

describe("host-fs.peek / stat / text / volume", () => {
  test("peek names the children, and refuses a missing folder", async () => {
    const peek = await dirPeek(root);
    expect(peek.kind).toBe("ok");
    expect(await refusalCode(dirPeek(join(root, "nope")))).toBe("missing");
  });

  test("stat describes a path, and refuses a missing one", async () => {
    const stat = await hostFsPathStatServed.load({ path: join(root, "b.txt") });
    expect(stat.entry.kind).toBe("file");
    expect(
      await refusalCode(
        hostFsPathStatServed.load({ path: join(root, "nope") }),
      ),
    ).toBe("missing");
  });

  test("text reads a file, and refuses a binary one or a folder", async () => {
    const text = await hostFsFileTextServed.load({ path: join(root, "b.txt") });
    expect(text.content).toBe("b.txt");
    expect(
      await refusalCode(
        hostFsFileTextServed.load({ path: join(root, "binary.bin") }),
      ),
    ).toBe("binary");
    expect(
      await refusalCode(hostFsFileTextServed.load({ path: join(root, "sub") })),
    ).toBe("not-a-file");
  });

  test("volume measures the volume, and refuses a missing path", async () => {
    const volume = await hostFsVolumeInfoServed.load({ path: root });
    expect(volume.total).toBeGreaterThan(0);
    expect(
      await refusalCode(
        hostFsVolumeInfoServed.load({ path: join(root, "nope") }),
      ),
    ).toBe("missing");
  });
});

/** Fake dir watches: every open one, emitting by path on demand. */
function fakeDirs() {
  const live = new Set<DirWatchRequest>();
  let failNext = 0;
  const acquire: AcquireDirWatch = async (req) => {
    if (failNext > 0) {
      failNext--;
      throw new Error(`cannot watch ${req.dir}`);
    }
    live.add(req);
    return () => {
      live.delete(req);
    };
  };
  /** The dirs watched now, each once, sorted. */
  const watched = () => [...new Set([...live].map((r) => r.dir))].sort();
  /** The change at `path`, to every watch whose scope holds it. */
  const emit = (
    path: string,
    type: "create" | "update" | "delete" = "create",
  ) => {
    for (const req of [...live]) {
      if (path === req.dir || dirname(path) === req.dir) {
        void req.onChange([{ type, path }]);
      }
    }
  };
  /** Make the next `n` acquires fail (the hub could not open them). */
  const fail = (n: number) => {
    failNext = n;
  };
  return { acquire, watched, emit, fail, live };
}

/** Lets the watch's queued re-arm (a promise chain) run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("watchHostDir", () => {
  test("hears an entry of the folder change, and stops on release", async () => {
    const dir = join(root, "watched");
    mkdirSync(dir);
    const dirs = fakeDirs();
    let heard = 0;
    const release = await watchHostDirOver(dirs.acquire, dir, () => heard++);
    // Nothing at arm time: the runtime reads only once the watch is live.
    expect(heard).toBe(0);
    expect(dirs.watched()).toEqual([dir]);
    dirs.emit(join(dir, "new.txt"));
    expect(heard).toBe(1);
    // Deeper changes are another folder's.
    dirs.emit(join(dir, "sub", "deep.txt"));
    expect(heard).toBe(1);
    release();
    expect(dirs.live.size).toBe(0);
  });

  test("waits for a missing folder in its parent, then watches it", async () => {
    const dir = join(root, "later");
    const dirs = fakeDirs();
    let heard = 0;
    const release = await watchHostDirOver(dirs.acquire, dir, () => heard++);
    expect(dirs.watched()).toEqual([root]);
    // A sibling's change is not this folder's.
    dirs.emit(join(root, "other.txt"));
    expect(heard).toBe(0);
    mkdirSync(dir);
    dirs.emit(dir);
    await settle();
    // Re-armed on the folder itself, then read: the parent's watch is given back.
    expect(heard).toBe(1);
    expect(dirs.watched()).toEqual([dir]);
    dirs.emit(join(dir, "inside.txt"));
    expect(heard).toBe(2);
    // The folder going re-arms on its parent again.
    rmSync(dir, { recursive: true });
    dirs.emit(dir, "delete");
    await settle();
    expect(dirs.watched()).toEqual([root]);
    release();
    expect(dirs.live.size).toBe(0);
  });

  test("climbs to the nearest folder that is there, and down again as the path is created", async () => {
    const top = join(root, "deep-a");
    const dir = join(top, "b", "c");
    const dirs = fakeDirs();
    let heard = 0;
    const release = await watchHostDirOver(dirs.acquire, dir, () => heard++);
    expect(dirs.watched()).toEqual([root]);
    mkdirSync(join(top, "b"), { recursive: true });
    dirs.emit(top);
    await settle();
    expect(dirs.watched()).toEqual([join(top, "b")]);
    mkdirSync(dir);
    dirs.emit(dir);
    await settle();
    expect(dirs.watched()).toEqual([dir]);
    dirs.emit(join(dir, "x.txt"));
    expect(heard).toBeGreaterThanOrEqual(1);
    release();
    expect(dirs.live.size).toBe(0);
  });

  test("a failed re-arm is reported once and retried on the next event", async () => {
    const dir = join(root, "flaky");
    const dirs = fakeDirs();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const release = await watchHostDirOver(dirs.acquire, dir, () => {});
      mkdirSync(dir);
      dirs.fail(1);
      dirs.emit(dir);
      await settle();
      expect(errors.length).toBe(1);
      // Still waiting in the parent; the next event arms the folder.
      expect(dirs.watched()).toEqual([root]);
      dirs.emit(dir);
      await settle();
      expect(dirs.watched()).toEqual([dir]);
      release();
    } finally {
      console.error = original;
    }
  });
});

describe("watchHostPath", () => {
  test("a symlink is heard where it points, and a folder's stat follows its entries", async () => {
    const target = join(root, "link-target");
    mkdirSync(target);
    writeFileSync(join(target, "real.txt"), "x");
    const link = join(root, "link.txt");
    symlinkSync(join(target, "real.txt"), link);
    const dirs = fakeDirs();
    let heard = 0;
    const release = await watchHostPathOver(dirs.acquire, link, () => heard++);
    expect(dirs.watched()).toEqual([root, target].sort());
    dirs.emit(join(target, "real.txt"), "update");
    expect(heard).toBe(1);
    release();
    expect(dirs.live.size).toBe(0);

    const folder = join(root, "stat-folder");
    mkdirSync(folder);
    let folderHeard = 0;
    const stop = await watchHostPathOver(
      dirs.acquire,
      folder,
      () => folderHeard++,
    );
    dirs.emit(join(folder, "child.txt"));
    expect(folderHeard).toBe(1);
    stop();
  });

  test("a file whose folder is missing is heard once both are created", async () => {
    const file = join(root, "dist", "out.js");
    const dirs = fakeDirs();
    let heard = 0;
    const release = await watchHostPathOver(dirs.acquire, file, () => heard++);
    expect(dirs.watched()).toEqual([root]);
    mkdirSync(join(root, "dist"));
    dirs.emit(join(root, "dist"));
    await settle();
    expect(dirs.watched()).toEqual([join(root, "dist")]);
    writeFileSync(file, "x");
    dirs.emit(file);
    await settle();
    expect(heard).toBeGreaterThanOrEqual(2);
    release();
    expect(dirs.live.size).toBe(0);
  });
});
