import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { REEXEC_ENV, reexecAfterInstall, takeReexecBudget } from "./reexec";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Records what the child WOULD have been, so the argv/env hand-off is assertable. */
function recordingSpawn(exitCode = 0) {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] =
    [];
  return {
    calls,
    spawn: (argv: string[], env: Record<string, string | undefined>) => {
      calls.push({ argv, env });
      return Promise.resolve({ exitCode });
    },
  };
}

test("re-execs the same entry and args, and marks the child as generation 1", async () => {
  const { calls, spawn } = recordingSpawn();

  const outcome = await reexecAfterInstall(
    "/repo/bin/index.ts",
    takeReexecBudget({}),
    {
      args: ["push", "-m", "msg with spaces"],
      env: { PATH: "/usr/bin" },
      spawn,
    },
  );

  expect(outcome).toEqual({ reexeced: true, exitCode: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.argv).toEqual([
    "/repo/bin/index.ts",
    "push",
    "-m",
    "msg with spaces",
  ]);
  // The child must still see the invoking environment — the push flow hands its
  // host CPU grant down through env, and `build` reads its detached marker.
  expect(calls[0]!.env.PATH).toBe("/usr/bin");
  expect(calls[0]!.env[REEXEC_ENV]).toBe("1");
});

test("propagates the child's exit code so the wrapper's status is the command's", async () => {
  const { spawn } = recordingSpawn(17);
  const outcome = await reexecAfterInstall(
    "/repo/bin/index.ts",
    takeReexecBudget({}),
    {
      args: ["check"],
      env: {},
      spawn,
    },
  );
  expect(outcome).toEqual({ reexeced: true, exitCode: 17 });
});

test("a second install in a re-exec'd process re-execs once more", async () => {
  const { calls, spawn } = recordingSpawn();
  const outcome = await reexecAfterInstall(
    "/repo/bin/index.ts",
    takeReexecBudget({ [REEXEC_ENV]: "1" }),
    { args: ["build"], env: {}, spawn },
  );
  expect(outcome.reexeced).toBe(true);
  expect(calls[0]!.env[REEXEC_ENV]).toBe("2");
});

test("the budget is bounded — a checkout whose inputs keep churning cannot fork-bomb", async () => {
  const { calls, spawn } = recordingSpawn();
  const outcome = await reexecAfterInstall(
    "/repo/bin/index.ts",
    takeReexecBudget({ [REEXEC_ENV]: "2" }),
    { args: ["build"], env: {}, spawn },
  );
  expect(calls).toHaveLength(0);
  expect(outcome.reexeced).toBe(false);
  if (outcome.reexeced) throw new Error("unreachable");
  expect(outcome.reason).toContain("not re-exec'ing further");
});

test("a garbled counter spends the budget rather than granting an unbounded one", async () => {
  const { calls, spawn } = recordingSpawn();
  for (const raw of ["nonsense", "-1", ""]) {
    const outcome = await reexecAfterInstall(
      "/repo/bin/index.ts",
      takeReexecBudget({ [REEXEC_ENV]: raw }),
      { args: ["build"], env: {}, spawn },
    );
    expect(outcome.reexeced).toBe(false);
  }
  expect(calls).toHaveLength(0);
});

test("taking the budget removes it from the environment descendants inherit", () => {
  const env: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    [REEXEC_ENV]: "1",
  };
  expect(takeReexecBudget(env).prior).toBe(1);
  expect(REEXEC_ENV in env).toBe(false);
  expect(env.PATH).toBe("/usr/bin");
  // A second read — what a nested `./equin` would see — starts fresh.
  expect(takeReexecBudget(env).prior).toBe(0);
});

test("a re-exec carries the counter only to its own child", async () => {
  const { calls, spawn } = recordingSpawn();
  const env: Record<string, string | undefined> = { [REEXEC_ENV]: "1" };
  const budget = takeReexecBudget(env);
  await reexecAfterInstall("/repo/bin/index.ts", budget, {
    args: ["build"],
    env,
    spawn,
  });
  expect(calls[0]!.env[REEXEC_ENV]).toBe("2");
  expect(env[REEXEC_ENV]).toBeUndefined();
});

/**
 * End-to-end, on a fixture mirroring the real bootstrap: a `bin/index.ts` that
 * installs a WORKSPACE-LOCAL `node_modules` from a subprocess (as `ensureDeps`
 * does) and then dynamically imports a module needing that package (as
 * `bin/cli.ts` is).
 *
 * The package is deliberately placed at `pkg/node_modules/…` rather than the
 * repo root's, because that is the shape that actually broke: `commander` is a
 * dependency of `plugins/framework/plugins/cli`, so the directory Bun cached as
 * absent while resolving the bootstrap's own imports is the very one the install
 * creates.
 *
 * Runs real `bun`, so it is a statement about the runtime rather than about our
 * mock of it — the point being that the fix holds for the actual resolver.
 *
 * Run for both non-`fresh` kinds. The `installed-by-other` arm is the concurrent
 * case: the package lands from ANOTHER process while this one waits (in the real
 * CLI, on `.install.lock`), which leaves this process's resolver exactly as stale
 * as installing itself — so it must re-exec too.
 */
test.each(["installed", "installed-by-other"] as const)(
  "a bootstrap whose deps were %s can run a command needing the new package",
  async (kind) => {
    const root = mkdtempSync(join(os.tmpdir(), "cli-reexec-"));
    fixtures.push(root);
    const bin = join(root, "pkg", "bin");

    write(
      join(root, "staged", "fixture-pkg", "package.json"),
      JSON.stringify({
        name: "fixture-pkg",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    write(
      join(root, "staged", "fixture-pkg", "index.js"),
      "module.exports = { ok: true };\n",
    );

    // Stands in for ensure-deps: the package lands from a subprocess — this
    // command's own install, or the other command's it waited on; to the resolver
    // the two are the same — and it reports which, as the real one does.
    write(
      join(bin, "install.ts"),
      `export async function ensureDeps(root: string): Promise<{ kind: string }> {
       if (await Bun.file(root + "/node_modules/fixture-pkg/package.json").exists()) {
         return { kind: "fresh" };
       }
       const p = Bun.spawn(["sh", "-c",
         "mkdir -p " + root + "/node_modules && cp -R " + root + "/../staged/fixture-pkg " + root + "/node_modules/"],
         { stdout: "inherit", stderr: "inherit" });
       await p.exited;
       return { kind: ${JSON.stringify(kind)} };
     }\n`,
    );
    // Stands in for cli.ts: the module whose npm import must resolve.
    write(
      join(bin, "cli.ts"),
      `import pkg from "fixture-pkg";
     console.log("COMMAND RAN", JSON.stringify(pkg), process.argv.slice(2).join(" "));\n`,
    );
    // Stands in for bin/index.ts, steps 2-4.
    write(
      join(bin, "index.ts"),
      `import { ensureDeps } from "./install";
     const root = import.meta.dir + "/..";
     const deps = await ensureDeps(root);
     if (deps.kind !== "fresh" && process.env.${REEXEC_ENV} === undefined) {
       const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
         stdio: ["inherit", "inherit", "inherit"],
         env: { ...process.env, ${REEXEC_ENV}: "1" },
       });
       process.exit(await child.exited);
     }
     await import("./cli");\n`,
    );

    // Cleared for a runner that is not the CLI (the bootstrap already takes the
    // counter out of `./equin test`'s own environment): an inherited
    // marker would make the fixture skip the very step under test.
    const env = { ...process.env };
    delete env[REEXEC_ENV];
    const result = await spawnCaptured(
      [process.execPath, join(bin, "index.ts"), "some-command"],
      {
        cwd: join(root, "pkg"),
        env,
        // The child is the CLI bootstrap re-exec'ing itself over a fixture package —
        // no install, no build. A bound is here because a hung child would hang the
        // whole test runner silently instead of failing this one case.
        timeoutMs: 60_000,
      },
    );

    expect(result.stderr).not.toContain("Cannot find package");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COMMAND RAN {"ok":true} some-command');
  },
);
