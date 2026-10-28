/**
 * A child started through the chokepoint must not outlive the process that
 * started it (research/2026-10-09-infra-spawn-children-die-with-parent.md).
 *
 * Each case runs a real PARENT process (`bun -e`) that spawns a child through
 * `spawnCaptured` / `spawnPassthrough` and publishes the child's pid, then kills
 * the parent the way the field does and asserts the child is gone:
 *
 * - SIGTERM, with the op CLI's signal → `process.exit` handler: the parent's
 *   exit hook (live-children) SIGTERMs the child.
 * - SIGKILL: no parent code runs; the child's own lifeline (`exitWithParent`)
 *   must notice — while its main thread is stuck in synchronous work, which is
 *   the type-check worker's shape.
 */
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "./internal/spawn-captured";
import { spawnPassthrough } from "./internal/spawn-passthrough";

const SPAWN_MODULE = join(import.meta.dir, "index.ts");
const LIFELINE_MODULE = join(
  import.meta.dir,
  "../../../../packages/plugins/flock/core/index.ts",
);

/** Bounded wait for a test-only condition (a readiness gate, not app logic). */
async function until(what: string, ok: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await Bun.sleep(25);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

/** A child body that publishes its pid, then occupies its MAIN thread. */
function childBody(ready: string, opts: { lifeline: boolean; spin: boolean }) {
  return `
    import { writeFileSync } from "node:fs";
    ${opts.lifeline ? `import { exitWithParent } from ${JSON.stringify(LIFELINE_MODULE)}; exitWithParent();` : ""}
    writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    ${
      opts.spin
        ? // Synchronous: no event-loop turn for 60 s, like a TS program build.
          "const end = Date.now() + 60_000; while (Date.now() < end) {}"
        : "await Bun.sleep(60_000);"
    }
  `;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/**
 * Start a parent that spawns `child` through `via`, wait until the child has
 * published its pid, and hand both back. Everything is SIGKILLed afterwards
 * whatever the test asserted.
 */
async function startParent(
  via: "spawnCaptured" | "spawnPassthrough",
  child: (ready: string) => string,
) {
  const dir = mkdtempSync(join(tmpdir(), "die-with-parent-"));
  const ready = join(dir, "child.pid");
  const childArgv = JSON.stringify([process.execPath, "-e", child(ready)]);
  const call =
    via === "spawnCaptured"
      ? `spawnCaptured(${childArgv}, { unbounded: "test child, killed by the test" })`
      : `spawnPassthrough(${childArgv})`;
  const parentScript = `
    import { ${via} } from ${JSON.stringify(SPAWN_MODULE)};
    // What an op CLI does (op-runtime installFatalSignalExit).
    process.on("SIGTERM", () => process.exit(143));
    await ${call};
  `;
  let kill: ((signal: NodeJS.Signals) => void) | undefined;
  const exited = spawnPassthrough([process.execPath, "-e", parentScript], {
    onSpawn: (c) => {
      kill = c.kill;
    },
  });
  cleanup.push(() => {
    kill?.("SIGKILL");
    if (existsSync(ready)) {
      const pid = Number(readFileSync(ready, "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await until("child published its pid", () => existsSync(ready));
  const childPid = Number(readFileSync(ready, "utf8"));
  expect(alive(childPid)).toBe(true);
  return {
    childPid,
    exited,
    kill: (signal: NodeJS.Signals) => kill?.(signal),
  };
}

test("SIGTERM of the parent takes a plain child with it (exit-hook reaper)", async () => {
  const p = await startParent("spawnCaptured", (ready) =>
    childBody(ready, { lifeline: false, spin: false }),
  );
  p.kill("SIGTERM");
  expect((await p.exited).exitCode).toBe(143);
  await until("child gone", () => !alive(p.childPid), 5_000);
});

test("SIGKILL of the parent takes a lifeline child with it, mid synchronous work", async () => {
  const p = await startParent("spawnCaptured", (ready) =>
    childBody(ready, { lifeline: true, spin: true }),
  );
  p.kill("SIGKILL");
  expect((await p.exited).signalCode).toBe("SIGKILL");
  await until("child gone", () => !alive(p.childPid), 5_000);
});

test("spawnPassthrough holds a lifeline too", async () => {
  const p = await startParent("spawnPassthrough", (ready) =>
    childBody(ready, { lifeline: true, spin: true }),
  );
  p.kill("SIGKILL");
  await p.exited;
  await until("child gone", () => !alive(p.childPid), 5_000);
});

test("a lifeline child that finishes on its own exits normally", async () => {
  const script = `
    import { exitWithParent } from ${JSON.stringify(LIFELINE_MODULE)};
    exitWithParent();
    process.stdout.write("done");
    process.exit(0);
  `;
  const result = await spawnCaptured([process.execPath, "-e", script], {
    timeoutMs: 15_000,
  });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done");
});

test("exitWithParent is a no-op without a lifeline (run standalone)", async () => {
  const script = `
    import { exitWithParent } from ${JSON.stringify(LIFELINE_MODULE)};
    delete process.env[${JSON.stringify(envName("PARENT_LIFELINE"))}];
    exitWithParent();
    await Bun.sleep(300);
    process.stdout.write("still here");
    process.exit(0);
  `;
  const result = await spawnCaptured([process.execPath, "-e", script], {
    timeoutMs: 15_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("still here");
});
