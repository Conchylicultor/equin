import { describe, expect, test } from "bun:test";
import type {
  DirWatchRequest,
  FileChangeEvent,
} from "@plugins/infra/plugins/file-watcher/server";
import {
  classifyGitDirEvent,
  classifyRootEvent,
  createCheckoutWatchHub,
  type CheckoutChange,
} from "./hub";

const ev = (path: string): FileChangeEvent => ({ type: "update", path });

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("classifyRootEvent", () => {
  test("a working-tree file is a worktree change", () => {
    expect(classifyRootEvent("/r", ev("/r/src/a.ts"))?.area).toBe("worktree");
  });
  test("HEAD, the index and refs under .git are git changes", () => {
    for (const p of [
      "/r/.git/HEAD",
      "/r/.git/index",
      "/r/.git/refs/heads/main",
    ]) {
      expect(classifyRootEvent("/r", ev(p))?.area).toBe("git");
    }
  });
  test("objects, reflogs, other worktrees' git dirs and node_modules are noise", () => {
    for (const p of [
      "/r/.git/objects/ab/cd",
      "/r/.git/logs/HEAD",
      "/r/.git/worktrees/other/index",
      "/r/node_modules/x/index.js",
      "/r/pkg/node_modules/y",
    ]) {
      expect(classifyRootEvent("/r", ev(p))).toBeNull();
    }
  });
  test("a path outside the root is not this checkout's", () => {
    expect(classifyRootEvent("/r", ev("/rr/a"))).toBeNull();
  });
});

describe("classifyGitDirEvent", () => {
  test("a linked worktree's own HEAD / index are git changes; its reflog is noise", () => {
    const gd = "/main/.git/worktrees/wt";
    expect(classifyGitDirEvent(gd, ev(`${gd}/HEAD`))?.area).toBe("git");
    expect(classifyGitDirEvent(gd, ev(`${gd}/index`))?.area).toBe("git");
    expect(classifyGitDirEvent(gd, ev(`${gd}/logs/HEAD`))).toBeNull();
  });
});

/** Fake dir watches: each acquire recorded, emitting by dir on demand. */
function fakeDirs() {
  const live = new Map<string, (events: FileChangeEvent[]) => void>();
  const acquired: string[] = [];
  const released: string[] = [];
  const acquireDirWatch = async (req: DirWatchRequest) => {
    if (req.dir.includes("missing")) throw new Error(`ENOENT ${req.dir}`);
    acquired.push(req.dir);
    live.set(req.dir, req.onChange);
    return () => {
      released.push(req.dir);
      live.delete(req.dir);
    };
  };
  const emit = (dir: string, ...paths: string[]) =>
    live.get(dir)!(paths.map(ev));
  return { acquireDirWatch, acquired, released, emit };
}

describe("createCheckoutWatchHub", () => {
  test("a linked worktree watches its root plus its git dirs outside; readers share one watch", async () => {
    const dirs = fakeDirs();
    let probes = 0;
    const hub = createCheckoutWatchHub({
      acquireDirWatch: dirs.acquireDirWatch,
      gitDirsOutside: async () => {
        probes++;
        return ["/main/.git/worktrees/wt", "/main/.git/refs"];
      },
    });
    const a: CheckoutChange[] = [];
    const b: CheckoutChange[] = [];
    const ra = await hub.acquire("/wt", (c) => a.push(...c));
    const rb = await hub.acquire("/wt", (c) => b.push(...c));
    expect(probes).toBe(1);
    expect(dirs.acquired).toEqual([
      "/wt",
      "/main/.git/worktrees/wt",
      "/main/.git/refs",
    ]);

    dirs.emit("/wt", "/wt/src/a.ts", "/wt/node_modules/x");
    dirs.emit("/main/.git/refs", "/main/.git/refs/heads/main");
    expect(a.map((c) => [c.path, c.area])).toEqual([
      ["/wt/src/a.ts", "worktree"],
      ["/main/.git/refs/heads/main", "git"],
    ]);
    expect(b).toEqual(a);

    // Only noise: nobody is called.
    let calls = 0;
    const rc = await hub.acquire("/wt", () => calls++);
    dirs.emit("/main/.git/worktrees/wt", "/main/.git/worktrees/wt/logs/HEAD");
    expect(calls).toBe(0);

    ra();
    rb();
    expect(dirs.released).toEqual([]);
    rc();
    expect(dirs.released).toEqual([
      "/wt",
      "/main/.git/worktrees/wt",
      "/main/.git/refs",
    ]);
    expect(hub.roots()).toEqual([]);
  });

  test("a git dir that cannot be watched releases what was opened and rejects", async () => {
    const dirs = fakeDirs();
    const hub = createCheckoutWatchHub({
      acquireDirWatch: dirs.acquireDirWatch,
      gitDirsOutside: async () => ["/missing/.git"],
    });
    const err = await rejection(hub.acquire("/wt", () => {}));
    expect(err.message).toContain("ENOENT");
    expect(dirs.released).toEqual(["/wt"]);
    expect(hub.roots()).toEqual([]);
  });
});
