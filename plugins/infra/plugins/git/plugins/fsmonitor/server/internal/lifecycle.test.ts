import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { readIndexFsmonitorToken } from "@plugins/infra/plugins/git/plugins/index-refresh/core";
import {
  listFsmonitorDaemons,
  listRunningDaemons,
  tokenDaemonPid,
} from "./daemons";
import {
  ensureCheckoutFsmonitor,
  reconcileCheckoutFsmonitors,
  startCheckoutFsmonitor,
  stopCheckoutFsmonitor,
} from "./lifecycle";

// A throwaway repository with linked worktrees (each with its own
// config.worktree, as the app's checkouts) — never a real checkout. Its
// daemons are real git fsmonitor daemons.
let root: string;
let repo: string;
const worktrees: Record<string, { path: string; gitDir: string }> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnCaptured([GIT, "-C", cwd, ...args], {
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function addWorktree(name: string) {
  const path = join(root, name);
  await git(repo, "worktree", "add", "-q", path, "-b", name);
  worktrees[name] = { path, gitDir: join(repo, ".git", "worktrees", name) };
  return worktrees[name]!;
}

/** The pid of the daemon listening for this git dir (its socket names it). */
async function daemonOf(gitDir: string): Promise<number | null> {
  return (
    (await listFsmonitorDaemons()).find((d) => d.gitDir === gitDir)?.pid ?? null
  );
}

function indexTokenPid(gitDir: string): number | null {
  return tokenDaemonPid(
    readIndexFsmonitorToken(readFileSync(join(gitDir, "index"))),
  );
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    await Bun.sleep(50);
  }
  throw new Error(`daemon ${pid} still running`);
}

beforeAll(async () => {
  // Under /tmp, not the test tmpdir: a daemon's socket path past 104 bytes
  // is bound by a relative name, which `lsof` cannot map back to its git dir
  // (the orphan sweep's only way to find it). realpath: /tmp is /private/tmp.
  root = realpathSync(mkdtempSync("/tmp/fsmt-"));
  repo = join(root, "repo");
  await spawnCaptured([GIT, "init", "-q", repo], { timeoutMs: 60_000 });
  writeFileSync(join(repo, "a.txt"), "a");
  await git(repo, "add", ".");
  await git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "c",
  );
  await git(repo, "config", "extensions.worktreeConfig", "true");
});

afterAll(async () => {
  for (const path of [repo, ...Object.values(worktrees).map((w) => w.path)]) {
    await spawnCaptured([GIT, "-C", path, "fsmonitor--daemon", "stop"], {
      timeoutMs: 60_000,
    });
  }
  rmSync(root, { recursive: true, force: true });
});

test("start turns the checkout's own fsmonitor on and starts its daemon; again finds it running", async () => {
  const wt = await addWorktree("wt-start");
  expect(await startCheckoutFsmonitor(wt.path)).toBe("started");
  expect(readFileSync(join(wt.gitDir, "config.worktree"), "utf8")).toMatch(
    /fsmonitor = true/,
  );
  // The repo's shared config is untouched: only this checkout watches.
  expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toMatch(
    /fsmonitor/,
  );
  expect(await daemonOf(wt.gitDir)).not.toBeNull();
  expect(await startCheckoutFsmonitor(wt.path)).toBe("running");
});

test("ensure renews an index token no running daemon issued, then finds it current", async () => {
  const wt = await addWorktree("wt-ensure");
  // An index written before the daemon: no token at all.
  expect(indexTokenPid(wt.gitDir)).toBeNull();
  const first = await ensureCheckoutFsmonitor(wt.path, "background");
  expect(first.token.kind).toBe("renewed");
  const pid = await daemonOf(wt.gitDir);
  expect(pid).not.toBeNull();
  expect(indexTokenPid(wt.gitDir)).toBe(pid);
  expect((await ensureCheckoutFsmonitor(wt.path, "background")).token).toEqual({
    kind: "current",
  });

  // The daemon dies and comes back (a reboot): the token is a dead daemon's.
  await git(wt.path, "fsmonitor--daemon", "stop");
  await waitGone(pid!);
  const again = await ensureCheckoutFsmonitor(wt.path, "background");
  expect(again.daemon).toBe("started");
  expect(again.token).toMatchObject({ kind: "renewed", was: pid });
  expect(indexTokenPid(wt.gitDir)).toBe(await daemonOf(wt.gitDir));
});

test("a token the running daemon no longer answers (same pid) is renewed; one taken back is not stopped", async () => {
  const wt = await addWorktree("wt-resync");
  await ensureCheckoutFsmonitor(wt.path, "background");
  const pid = (await daemonOf(wt.gitDir))!;
  // The same daemon, but the index's token is one it never issued (as after
  // a resync: a new token id under the same pid).
  const index = join(wt.gitDir, "index");
  const bytes = readFileSync(index);
  const token = readIndexFsmonitorToken(bytes)!;
  const forged = token.replace(/^builtin:\d+\./, "builtin:99.");
  expect(forged).not.toBe(token);
  writeFileSync(
    index,
    Buffer.from(bytes.toString("latin1").replace(token, forged), "latin1"),
  );
  const done = await ensureCheckoutFsmonitor(wt.path, "background");
  expect(done).toMatchObject({
    daemon: "running",
    token: { kind: "renewed", was: pid },
  });
  expect(readIndexFsmonitorToken(readFileSync(index))).not.toBe(forged);
  expect((await ensureCheckoutFsmonitor(wt.path, "background")).token).toEqual({
    kind: "current",
  });

  // Wanted off, but taken back before the stop: left running.
  const r = await reconcileCheckoutFsmonitors([{ ...wt, want: "off" }], {
    orphanRoot: join(repo, ".git", "worktrees"),
    tier: "background",
    stillOff: async () => false,
  });
  expect(r.stopped).toEqual([]);
  expect(await daemonOf(wt.gitDir)).toBe(pid);
});

test("a daemon running throttled (auto-started from a background process) is restarted at foreground", async () => {
  const wt = await addWorktree("wt-throttled");
  await git(wt.path, "config", "--worktree", "core.fsmonitor", "true");
  // As git auto-starts it for a background-tier reader: darwinbg.
  const r = await spawnCaptured(
    [GIT, "-C", wt.path, "fsmonitor--daemon", "start"],
    { timeoutMs: 60_000, tier: "background" },
  );
  expect(r.exitCode).toBe(0);
  const throttled = (await daemonOf(wt.gitDir))!;
  expect((await listRunningDaemons()).get(throttled)?.throttled).toBe(true);

  const done = await ensureCheckoutFsmonitor(wt.path, "background");
  expect(done.daemon).toBe("restarted");
  await waitGone(throttled);
  const now = (await daemonOf(wt.gitDir))!;
  expect((await listRunningDaemons()).get(now)?.throttled).toBe(false);
  expect(indexTokenPid(wt.gitDir)).toBe(now);
});

test("stop unsets the config first and stops the daemon; again finds nothing", async () => {
  const wt = await addWorktree("wt-stop");
  await startCheckoutFsmonitor(wt.path);
  const pid = (await daemonOf(wt.gitDir))!;
  expect(await stopCheckoutFsmonitor(wt.path)).toEqual({
    config: "unset",
    daemon: "stopped",
  });
  await waitGone(pid);
  expect(await daemonOf(wt.gitDir)).toBeNull();
  expect(await stopCheckoutFsmonitor(wt.path)).toEqual({
    config: "absent",
    daemon: "not-running",
  });
});

test("reconcile: on is started with a current token, off is stopped, unknown is left, a gone checkout's daemon is signalled", async () => {
  const on = await addWorktree("wt-on");
  const off = await addWorktree("wt-off");
  const unknown = await addWorktree("wt-unknown");
  const gone = await addWorktree("wt-gone");
  await startCheckoutFsmonitor(off.path);
  await startCheckoutFsmonitor(unknown.path);
  await startCheckoutFsmonitor(gone.path);
  const gonePid = (await daemonOf(gone.gitDir))!;
  // Its registration pruned: the admin dir's gitdir file is gone.
  renameSync(join(gone.gitDir, "gitdir"), join(gone.gitDir, "gitdir.away"));

  const r = await reconcileCheckoutFsmonitors(
    [
      { ...on, want: "on" },
      { ...off, want: "off" },
      { ...unknown, want: "unknown" },
    ],
    {
      orphanRoot: join(repo, ".git", "worktrees"),
      tier: "background",
      stillOff: async () => true,
    },
  );
  expect(r.failures).toEqual([]);
  expect(r.started).toEqual([on.path]);
  expect(r.renewed).toEqual([on.path]);
  expect(r.stopped).toEqual([off.path]);
  expect(r.orphans).toEqual([gonePid]);
  expect(indexTokenPid(on.gitDir)).toBe(await daemonOf(on.gitDir));
  expect(await daemonOf(unknown.gitDir)).not.toBeNull();
  await waitGone(gonePid);
  renameSync(join(gone.gitDir, "gitdir.away"), join(gone.gitDir, "gitdir"));

  // A second pass has nothing to do.
  const again = await reconcileCheckoutFsmonitors(
    [
      { ...on, want: "on" },
      { ...off, want: "off" },
    ],
    {
      orphanRoot: join(repo, ".git", "worktrees"),
      tier: "background",
      stillOff: async () => true,
    },
  );
  expect(again).toMatchObject({
    started: [],
    renewed: [],
    stopped: [],
    orphans: [],
    failures: [],
  });
});

/** core.fsmonitor as a git in `path` reads it, the host's own config ignored. */
async function fsmonitorSetting(path: string): Promise<string | null> {
  const r = await spawnCaptured(
    [GIT, "-C", path, "config", "--get", "core.fsmonitor"],
    {
      timeoutMs: 60_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (r.exitCode === 1) return null;
  if (r.exitCode !== 0) throw new Error(`git config failed: ${r.stderr}`);
  return r.stdout.trim();
}

test("the MAIN worktree is turned on through a gitdir-scoped include — not config.worktree, which `git worktree add` copies — so no linked checkout, made before or after, is on", async () => {
  const before = await addWorktree("wt-before-main");
  const mainGitDir = join(repo, ".git");
  const opts = {
    orphanRoot: join(repo, ".git", "worktrees"),
    tier: "background" as const,
    stillOff: async () => true,
  };
  const r = await reconcileCheckoutFsmonitors(
    [{ path: repo, gitDir: mainGitDir, want: "on" }],
    opts,
  );
  expect(r.failures).toEqual([]);
  expect(r.started).toEqual([repo]);
  expect(await fsmonitorSetting(repo)).toBe("true");
  expect(
    readFileSync(join(mainGitDir, "equin-fsmonitor.config"), "utf8"),
  ).toMatch(/fsmonitor = true/);
  const shared = readFileSync(join(mainGitDir, "config"), "utf8");
  expect(shared).toContain(`[includeIf "gitdir:${mainGitDir}"]`);
  expect(shared).not.toMatch(/fsmonitor = /);
  expect(indexTokenPid(mainGitDir)).toBe(await daemonOf(mainGitDir));

  // A plain `git worktree add` after main is on: nothing copied.
  const after = join(root, "wt-after-main");
  await git(repo, "worktree", "add", "-q", after, "-b", "wt-after-main");
  for (const path of [before.path, after]) {
    expect(await fsmonitorSetting(path)).toBeNull();
  }
  expect(await daemonOf(before.gitDir)).toBeNull();

  // Again: nothing to do, and the include is not added twice.
  const again = await reconcileCheckoutFsmonitors(
    [{ path: repo, gitDir: mainGitDir, want: "on" }],
    opts,
  );
  expect(again).toMatchObject({ started: [], renewed: [], failures: [] });
  expect(
    readFileSync(join(mainGitDir, "config"), "utf8").split("includeIf").length,
  ).toBe(2);

  // Off: the include's file loses the key, the daemon stops.
  const pid = (await daemonOf(mainGitDir))!;
  expect(await stopCheckoutFsmonitor(repo)).toEqual({
    config: "unset",
    daemon: "stopped",
  });
  expect(await fsmonitorSetting(repo)).toBeNull();
  await waitGone(pid);
});
