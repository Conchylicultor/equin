import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  markWorktreeOpStart,
  probeWorktreeOp,
} from "./worktree-op";

// The marker functions resolve their path from the real worktreeDataDir(slug);
// there is no path injection. So each test uses a throwaway random slug (never
// a real worktree), writes under the real worktrees dir, and reaps the whole
// slug dir in a finally.

const opsDirOf = (slug: Namespace) => join(worktreeDataDir(slug), "ops");

async function withTempSlug(
  fn: (slug: Namespace) => Promise<void>,
): Promise<void> {
  const slug = asNamespace(`op-test-${randomUUID()}`);
  try {
    await fn(slug);
  } finally {
    rmSync(worktreeDataDir(slug), { recursive: true, force: true });
  }
}

function writeRaw(slug: Namespace, file: string, data: unknown): string {
  mkdirSync(opsDirOf(slug), { recursive: true });
  const path = join(opsDirOf(slug), file);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

// --- the held marker --------------------------------------------------------

test("a held marker is one v2 file per op, read back live", async () => {
  await withTempSlug(async (slug) => {
    const marker = markWorktreeOpStart(slug, "build", "op-1");
    try {
      expect(marker.path).toBe(join(opsDirOf(slug), "op-1.json"));
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
    const mine = await listActiveWorktreeOps();
    const here = mine.filter((m) => m.slug === slug);
    expect(here.map((m) => [m.op, m.opId])).toEqual([["build", "legacy-1"]]);
    expect(existsSync(dead)).toBe(false);
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
    const modulePath = join(import.meta.dir, "worktree-op.ts");
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
