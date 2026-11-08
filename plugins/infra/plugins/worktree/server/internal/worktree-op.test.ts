import { test, expect } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import {
  asNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";
import {
  isWorktreeOpActive,
  listActiveWorktreeOps,
  listWorktreeOps,
  liveOpLink,
  probeWorktreeOp,
} from "./worktree-op";
import { markWorktreeOpStart } from "./worktree-op-marker";
import { liveOpsDir } from "../../data-dirs";

// The marker functions resolve their path from the real worktreeDataDir(slug);
// there is no path injection. So each test uses a throwaway random slug (never
// a real worktree), writes under the real worktrees dir, and reaps the whole
// slug dir — and the slug's links in the host-wide live-ops index — in a
// finally.

const opsDirOf = (slug: Namespace) => joinAppPath(worktreeDataDir(slug), "ops");

async function withTempSlug(
  fn: (slug: Namespace) => Promise<void>,
): Promise<void> {
  const slug = asNamespace(`op-test-${randomUUID()}`);
  try {
    await fn(slug);
  } finally {
    rmSync(worktreeDataDir(slug), { recursive: true, force: true });
    if (existsSync(liveOpsDir.path))
      for (const name of readdirSync(liveOpsDir.path))
        if (name.startsWith(`${slug}~`))
          rmSync(join(liveOpsDir.path, name), { force: true });
  }
}

function writeRaw(slug: Namespace, file: string, data: unknown): string {
  mkdirSync(opsDirOf(slug), { recursive: true });
  const path = joinAppPath(opsDirOf(slug), file);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

// --- the held marker --------------------------------------------------------

test("a held marker is one v2 file per op, read back live", async () => {
  await withTempSlug(async (slug) => {
    const marker = markWorktreeOpStart(slug, "build", "op-1");
    try {
      expect(marker.path).toBe(joinAppPath(opsDirOf(slug), "op-1.json"));
      const raw = JSON.parse(readFileSync(marker.path, "utf8")) as Record<
        string,
        unknown
      >;
      expect(raw).toMatchObject({
        v: 2,
        kind: "build",
        opId: "op-1",
        pid: process.pid,
      });
      expect(typeof raw.startedAt).toBe("string");

      // The probe opens its own file description, so the lock this process
      // holds on another one reads as held.
      const ops = await listWorktreeOps(slug);
      expect(ops).toEqual([
        {
          slug,
          op: "build",
          pid: process.pid,
          opId: "op-1",
          startedAt: raw.startedAt as string,
        },
      ]);
      expect(await probeWorktreeOp(slug, "op-1")).toBe("live");
      expect(await isWorktreeOpActive(slug)).toBe(true);
      // Probing never disturbs the holder, and never reaps a live marker.
      expect(existsSync(marker.path)).toBe(true);
    } finally {
      marker.release();
    }
    expect(existsSync(marker.path)).toBe(false);
    expect(await probeWorktreeOp(slug, "op-1")).toBe("absent");
    expect(await isWorktreeOpActive(slug)).toBe(false);
  });
});

test("two ops of one kind are two markers — neither overwrites the other", async () => {
  await withTempSlug(async (slug) => {
    const a = markWorktreeOpStart(slug, "check", "op-a");
    const b = markWorktreeOpStart(slug, "check", "op-b");
    try {
      const ids = (await listWorktreeOps(slug)).map((o) => o.opId).sort();
      expect(ids).toEqual(["op-a", "op-b"]);
      a.release();
      expect((await listWorktreeOps(slug)).map((o) => o.opId)).toEqual([
        "op-b",
      ]);
    } finally {
      a.release(); // idempotent
      b.release();
    }
  });
});

test("an unlocked v2 marker is a dead op: reported dead once, then reaped", async () => {
  await withTempSlug(async (slug) => {
    const path = writeRaw(slug, "op-dead.json", {
      v: 2,
      kind: "push",
      opId: "op-dead",
      // A LIVE pid on purpose: v2 liveness is the lock, never the pid.
      pid: process.pid,
      startedAt: "2026-09-29T00:00:00.000Z",
    });
    expect(await probeWorktreeOp(slug, "op-dead")).toBe("dead");
    expect(existsSync(path)).toBe(false);
    expect(await probeWorktreeOp(slug, "op-dead")).toBe("absent");
  });
});

// --- the host-wide live-ops index ------------------------------------------

test("a held marker is listed host-wide through its link, which is the same file", async () => {
  await withTempSlug(async (slug) => {
    const marker = markWorktreeOpStart(slug, "test", "op-host");
    const link = liveOpLink(slug, "op-host");
    try {
      expect(statSync(link).ino).toBe(statSync(marker.path).ino);
      const here = (await listActiveWorktreeOps()).filter(
        (m) => m.slug === slug,
      );
      expect(here.map((m) => [m.op, m.opId, m.pid])).toEqual([
        ["test", "op-host", process.pid],
      ]);
      expect(existsSync(link)).toBe(true);
    } finally {
      marker.release();
    }
    expect(existsSync(link)).toBe(false);
    expect(
      (await listActiveWorktreeOps()).filter((m) => m.slug === slug),
    ).toEqual([]);
  });
});

test("a dead op found through its link is reaped under both names", async () => {
  await withTempSlug(async (slug) => {
    // An unlocked v2 marker and its link: what a killed op leaves behind.
    const path = writeRaw(slug, "op-gone.json", {
      v: 2,
      kind: "build",
      opId: "op-gone",
      pid: process.pid,
      startedAt: "2026-11-08T00:00:00.000Z",
    });
    const link = liveOpLink(slug, "op-gone");
    linkSync(path, link);
    expect(
      (await listActiveWorktreeOps()).filter((m) => m.slug === slug),
    ).toEqual([]);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

test("a dead op found through its worktree's ops dir loses its link too", async () => {
  await withTempSlug(async (slug) => {
    const path = writeRaw(slug, "op-gone2.json", {
      v: 2,
      kind: "check",
      opId: "op-gone2",
      pid: process.pid,
      startedAt: "2026-11-08T00:00:00.000Z",
    });
    const link = liveOpLink(slug, "op-gone2");
    linkSync(path, link);
    expect(await probeWorktreeOp(slug, "op-gone2")).toBe("dead");
    expect(existsSync(link)).toBe(false);
  });
});

test("an op id already live refuses a second marker and leaves the first intact", async () => {
  await withTempSlug(async (slug) => {
    const first = markWorktreeOpStart(slug, "build", "op-dup");
    try {
      expect(() => markWorktreeOpStart(slug, "build", "op-dup")).toThrow();
      expect(await probeWorktreeOp(slug, "op-dup")).toBe("live");
      expect(existsSync(liveOpLink(slug, "op-dup"))).toBe(true);
    } finally {
      first.release();
    }
  });
});

test("an op id its link name could not carry is refused at the start", async () => {
  await withTempSlug(async (slug) => {
    expect(() => markWorktreeOpStart(slug, "build", "a~b")).toThrow(
      /no live-op link name/,
    );
    expect(await listWorktreeOps(slug)).toEqual([]);
  });
});

// --- the transition: legacy per-kind markers ---------------------------------

test("a legacy per-kind marker is live while its pid is, and reaped when not", async () => {
  await withTempSlug(async (slug) => {
    writeRaw(slug, "build.json", {
      op: "build",
      pid: process.pid,
      opId: "legacy-1",
      startedAt: "2026-09-29T00:00:00.000Z",
      phase: "running",
    });
    const dead = writeRaw(slug, "check.json", {
      op: "check",
      pid: 2 ** 22 + 12345, // above macOS/Linux pid_max: never a live pid
      opId: "legacy-2",
      startedAt: "2026-09-29T00:00:00.000Z",
    });
    const here = await listWorktreeOps(slug);
    expect(here.map((m) => [m.op, m.opId])).toEqual([["build", "legacy-1"]]);
    expect(existsSync(dead)).toBe(false);
    // A legacy marker was never linked into the host-wide index.
    expect(
      (await listActiveWorktreeOps()).filter((m) => m.slug === slug),
    ).toEqual([]);
    // A legacy marker has no per-op file, so a per-op probe says so.
    expect(await probeWorktreeOp(slug, "legacy-1")).toBe("absent");
  });
});

test("a legacy marker naming an unknown op falls back to build; garbage is reaped", async () => {
  await withTempSlug(async (slug) => {
    writeRaw(slug, "build.json", { op: "deploy", pid: process.pid });
    const junk = writeRaw(slug, "test.json", "{ not json");
    const ops = await listWorktreeOps(slug);
    expect(ops.map((o) => [o.op, o.opId])).toEqual([["build", null]]);
    expect(existsSync(junk)).toBe(false);
  });
});

test("a marker still being written is never probed; an orphaned one is reaped when stale", async () => {
  await withTempSlug(async (slug) => {
    const fresh = writeRaw(slug, "op-x.json.123.tmp", "{}");
    const stale = writeRaw(slug, "op-y.json.456.tmp", "{}");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(stale, old, old);
    expect(await listWorktreeOps(slug)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

// --- process death ----------------------------------------------------------

// The whole point of the flock: the kernel drops it when the holder dies, even
// by SIGKILL — and a child the holder spawned does NOT keep it (Bun/libuv open
// every fd close-on-exec), so a lingering grandchild cannot make a dead op look
// alive. Spawns a real holder process that spawns a `sleep`, then kills the
// holder only.
test("SIGKILL of the holder releases the marker even while its child lives on", async () => {
  await withTempSlug(async (slug) => {
    const ready = join(worktreeDataDir(slug), "ready.json");
    const modulePath = join(import.meta.dir, "worktree-op-marker.ts");
    const script = `
      import { writeFileSync } from "node:fs";
      import { markWorktreeOpStart } from ${JSON.stringify(modulePath)};
      markWorktreeOpStart(${JSON.stringify(slug)}, "build", "op-killed");
      const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ child: child.pid }));
      await Bun.sleep(60_000);
    `;
    let kill: ((signal?: number | NodeJS.Signals) => void) | undefined;
    const exited = spawnPassthrough([process.execPath, "-e", script], {
      onSpawn: (c) => {
        kill = c.kill;
      },
    });
    let grandchild: number | undefined;
    try {
      // Bounded wait for the holder to publish (a test-only readiness gate).
      const deadline = Date.now() + 15_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("holder never got ready");
        await Bun.sleep(25);
      }
      grandchild = (
        JSON.parse(readFileSync(ready, "utf8")) as { child: number }
      ).child;
      expect(await probeWorktreeOp(slug, "op-killed")).toBe("live");

      kill?.("SIGKILL");
      const result = await exited;
      expect(result.signalCode).toBe("SIGKILL");
      // The grandchild is still running — and holds nothing.
      expect(() => process.kill(grandchild as number, 0)).not.toThrow();
      expect(await probeWorktreeOp(slug, "op-killed")).toBe("dead");
      expect(await listWorktreeOps(slug)).toEqual([]);
    } finally {
      kill?.("SIGKILL");
      if (grandchild !== undefined) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }
    }
  });
});
