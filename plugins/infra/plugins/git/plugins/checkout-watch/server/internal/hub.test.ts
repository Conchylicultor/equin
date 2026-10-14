import { describe, expect, test } from "bun:test";
import type {
  DirWatchRequest,
  FileChangeEvent,
} from "@plugins/infra/plugins/file-watcher/server";
import {
  classifyGitDirEvent,
  classifyRootEvent,
  createCheckoutWatchHub,
  refAt,
  type CheckoutBranch,
  type CheckoutChange,
  type CheckoutRefs,
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
  const live = new Map<string, DirWatchRequest["onChange"]>();
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
  // The hub's own listeners are synchronous: the dir watch hears no promise.
  const emit = (dir: string, ...paths: string[]) =>
    void live.get(dir)!(paths.map(ev));
  return { acquireDirWatch, acquired, released, emit };
}

describe("refAt", () => {
  test("a loose ref or its lock is the ref; anything else is none", () => {
    expect(refAt("/m/.git", "/m/.git/refs/heads/a/b")).toBe("refs/heads/a/b");
    expect(refAt("/m/.git", "/m/.git/refs/heads/main.lock")).toBe(
      "refs/heads/main",
    );
    expect(refAt("/m/.git", "/m/.git/HEAD")).toBeUndefined();
    expect(refAt("/m/.git", "/m/.git/packed-refs")).toBeUndefined();
  });
});

const LINKED = {
  gitDir: "/main/.git/worktrees/wt",
  commonDir: "/main/.git",
};
const ALSO_NONE: CheckoutRefs = { also: [] };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** No path is ignored. */
const IGNORES_NONE = async () => new Set<string>();

function linkedHub(
  branch: () => CheckoutBranch = () => OWN,
  ignored: (
    root: string,
    relPaths: readonly string[],
  ) => Promise<ReadonlySet<string>> = IGNORES_NONE,
) {
  const dirs = fakeDirs();
  let probes = 0;
  const ignoreCalls: string[][] = [];
  const hub = createCheckoutWatchHub({
    acquireDirWatch: dirs.acquireDirWatch,
    locate: async () => {
      probes++;
      return LINKED;
    },
    readBranch: async () => branch(),
    ignored: (root, relPaths) => {
      ignoreCalls.push([...relPaths]);
      return ignored(root, relPaths);
    },
  });
  return { dirs, hub, probes: () => probes, ignoreCalls };
}

const OWN: CheckoutBranch = {
  own: "refs/heads/wt-branch",
  upstream: "refs/remotes/origin/wt-branch",
};

describe("createCheckoutWatchHub", () => {
  test("a linked worktree watches its root plus its git dirs outside; readers share one watch", async () => {
    const { dirs, hub, probes } = linkedHub();
    const a: CheckoutChange[] = [];
    const b: CheckoutChange[] = [];
    const also: CheckoutRefs = { also: ["refs/heads/main"] };
    const ra = await hub.acquire("/wt", {
      refs: also,
      onChange: (c) => void a.push(...c),
    });
    const rb = await hub.acquire("/wt", {
      refs: also,
      onChange: (c) => void b.push(...c),
    });
    expect(probes()).toBe(1);
    expect(dirs.acquired).toEqual([
      "/wt",
      "/main/.git/worktrees/wt",
      "/main/.git/refs",
    ]);

    dirs.emit("/wt", "/wt/src/a.ts", "/wt/node_modules/x");
    dirs.emit("/main/.git/refs", "/main/.git/refs/heads/main");
    await tick();
    expect(a.map((c) => [c.path, c.area, c.ref])).toEqual([
      ["/wt/src/a.ts", "worktree", undefined],
      ["/main/.git/refs/heads/main", "git", "refs/heads/main"],
    ]);
    expect(b).toEqual(a);

    // Only noise: nobody is called.
    let calls = 0;
    const rc = await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: () => void calls++,
    });
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

  test("other worktrees' refs reach nobody; the own branch, its upstream when asked, and named refs do", async () => {
    const { dirs, hub } = linkedHub();
    const plain: (string | undefined)[] = [];
    const withUpstream: (string | undefined)[] = [];
    await hub.acquire("/wt", {
      refs: { also: ["refs/heads/main"] },
      onChange: (c) => void plain.push(...c.map((x) => x.ref)),
    });
    await hub.acquire("/wt", {
      refs: { also: [], upstream: true },
      onChange: (c) => void withUpstream.push(...c.map((x) => x.ref)),
    });
    dirs.emit(
      "/main/.git/refs",
      "/main/.git/refs/heads/other-wt",
      "/main/.git/refs/heads/other-wt.lock",
      "/main/.git/refs/remotes/origin/other-wt",
    );
    expect(plain).toEqual([]);
    expect(withUpstream).toEqual([]);

    dirs.emit(
      "/main/.git/refs",
      "/main/.git/refs/heads/wt-branch",
      "/main/.git/refs/heads/main",
      "/main/.git/refs/remotes/origin/wt-branch",
    );
    expect(plain).toEqual(["refs/heads/wt-branch", "refs/heads/main"]);
    expect(withUpstream).toEqual([
      "refs/heads/wt-branch",
      "refs/remotes/origin/wt-branch",
    ]);
  });

  test("a HEAD change re-reads the branch before the batch is filtered", async () => {
    let branch: CheckoutBranch = OWN;
    const { dirs, hub } = linkedHub(() => branch);
    const heard: (string | undefined)[] = [];
    await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: (c) => void heard.push(...c.map((x) => x.ref ?? x.path)),
    });
    branch = { own: "refs/heads/next", upstream: null };
    dirs.emit("/main/.git/worktrees/wt", "/main/.git/worktrees/wt/HEAD");
    dirs.emit("/main/.git/refs", "/main/.git/refs/heads/next");
    dirs.emit("/main/.git/refs", "/main/.git/refs/heads/wt-branch");
    await tick();
    expect(heard).toEqual(["/main/.git/worktrees/wt/HEAD", "refs/heads/next"]);
  });

  test("a flood against a slow reader: at most one running plus one pending, and a final run after the last batch", async () => {
    const { dirs, hub } = linkedHub();
    const gates: (() => void)[] = [];
    const runs: number[] = [];
    let running = 0;
    let maxRunning = 0;
    await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: async (changes) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        runs.push(changes.length);
        await new Promise<void>((r) => gates.push(r));
        running -= 1;
      },
    });
    for (let i = 0; i < 500; i++) dirs.emit("/wt", `/wt/f${i}.ts`);
    await tick();
    expect(runs).toEqual([1]);
    gates.shift()!();
    await tick();
    // The 499 batches that landed mid-run are ONE trailing run.
    expect(runs).toEqual([1, 499]);
    dirs.emit("/wt", "/wt/last.ts");
    gates.shift()!();
    await tick();
    expect(runs).toEqual([1, 499, 1]);
    gates.shift()!();
    await tick();
    expect(runs.length).toBe(3);
    expect(maxRunning).toBe(1);
  });

  test("a reader released mid-run is not called again", async () => {
    const { dirs, hub } = linkedHub();
    let calls = 0;
    let open!: () => void;
    const release = await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: async () => {
        calls += 1;
        await new Promise<void>((r) => (open = r));
      },
    });
    dirs.emit("/wt", "/wt/a.ts");
    await tick();
    dirs.emit("/wt", "/wt/b.ts");
    await tick();
    release();
    open();
    await tick();
    expect(calls).toBe(1);
  });

  test("a git dir that cannot be watched releases what was opened and rejects", async () => {
    const dirs = fakeDirs();
    const hub = createCheckoutWatchHub({
      acquireDirWatch: dirs.acquireDirWatch,
      locate: async () => ({
        gitDir: "/missing/.git",
        commonDir: "/missing/.git",
      }),
      readBranch: async () => OWN,
      ignored: IGNORES_NONE,
    });
    const err = await rejection(
      hub.acquire("/wt", { refs: ALSO_NONE, onChange: () => {} }),
    );
    expect(err.message).toContain("ENOENT");
    expect(dirs.released).toEqual(["/wt"]);
    expect(hub.roots()).toEqual([]);
  });

  test("working-tree paths git ignores reach nobody; a mixed batch keeps the rest", async () => {
    const { dirs, hub, ignoreCalls } = linkedHub(
      () => OWN,
      async (_root, relPaths) =>
        new Set(relPaths.filter((p) => p.startsWith("dist/"))),
    );
    const heard: string[] = [];
    await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: (c) => void heard.push(...c.map((x) => x.path)),
    });

    dirs.emit("/wt", "/wt/dist/a.js", "/wt/dist/b.js", "/wt/dist/a.js");
    await tick();
    expect(heard).toEqual([]);
    // One question per batch, each path asked once, relative to the root.
    expect(ignoreCalls).toEqual([["dist/a.js", "dist/b.js"]]);

    dirs.emit("/wt", "/wt/dist/c.js", "/wt/src/a.ts");
    await tick();
    expect(heard).toEqual(["/wt/src/a.ts"]);
  });

  test("a git-dir-only batch asks nothing and is delivered in the same turn", async () => {
    const { dirs, hub, ignoreCalls } = linkedHub();
    const heard: string[] = [];
    await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: (c) => void heard.push(...c.map((x) => x.path)),
    });
    dirs.emit("/main/.git/worktrees/wt", "/main/.git/worktrees/wt/index");
    expect(heard).toEqual(["/main/.git/worktrees/wt/index"]);
    expect(ignoreCalls).toEqual([]);
  });

  test("readers share one ignore check per batch", async () => {
    const { dirs, hub, ignoreCalls } = linkedHub();
    const a: string[] = [];
    const b: string[] = [];
    await hub.acquire("/wt", {
      refs: ALSO_NONE,
      onChange: (c) => void a.push(...c.map((x) => x.path)),
    });
    await hub.acquire("/wt", {
      refs: { also: ["refs/heads/main"] },
      onChange: (c) => void b.push(...c.map((x) => x.path)),
    });
    dirs.emit("/wt", "/wt/src/a.ts");
    await tick();
    expect(ignoreCalls.length).toBe(1);
    expect(a).toEqual(["/wt/src/a.ts"]);
    expect(b).toEqual(["/wt/src/a.ts"]);
  });
});
