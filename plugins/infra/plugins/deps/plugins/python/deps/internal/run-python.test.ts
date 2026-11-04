import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { z } from "zod";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import { pythonEnv } from "./python-env";
import { PythonEntryError, runPython } from "./run-python";
import { uvEnv } from "./uv";

// The runPython contract, against a uv-managed CPython standing in for an
// installed env: a fake env whose bin/python links to it (as a real env's
// does), and a throwaway project holding the modules. Never the machine's own
// python3: on macOS that is an xcode-select shim, which pops the "install the
// command line developer tools" dialog when run under a name it does not know
// (`python`) or on a machine without the tools.
let base: AppPath;
let ready: ReturnType<typeof makeReady>;

function makeReady() {
  const project = join(base, "project");
  const dep = defineDep({
    id: "run-python-test",
    owner: "infra/deps/python",
    description: "",
    sizeHint: "",
    source: pythonEnv({ project: relative(REPO_ROOT, project) }),
  });
  return readyForTests(dep, joinAppPath(base, "env"), "test-identity");
}

/** `uv python <args>` under the python kind's own env (managed Pythons only). */
async function uvPython(args: string[]) {
  // From the repo root: its mise.lock picks the uv release (the shim refuses
  // a directory with no mise config, like the temp dir).
  return spawnCaptured(["uv", "python", ...args], {
    cwd: REPO_ROOT,
    env: uvEnv(),
    timeoutMs: 10 * 60_000,
  });
}

/**
 * A uv-managed interpreter: any one already downloaded into the declared
 * `cache/uv-python`, else the newest (one download, then cached).
 */
async function managedPython(): Promise<string> {
  let found = await uvPython(["find", "--no-project"]);
  if (found.exitCode !== 0) {
    // `--no-bin`: no `python3.x` link dropped into ~/.local/bin.
    const install = await uvPython(["install", "--no-bin"]);
    if (install.exitCode !== 0) {
      throw new Error(`uv python install failed: ${install.stderr.trim()}`);
    }
    found = await uvPython(["find", "--no-project"]);
  }
  if (found.exitCode !== 0) {
    throw new Error(`uv python find failed: ${found.stderr.trim()}`);
  }
  return found.stdout.trim();
}

beforeAll(async () => {
  base = asAppPath(mkdtempSync(join(tmpdir(), "run-python-")));
  mkdirSync(join(base, "env", "bin"), { recursive: true });
  symlinkSync(await managedPython(), join(base, "env", "bin", "python"));
  const pkg = join(base, "project", "fixture");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(
    join(pkg, "echo.py"),
    'import json, sys\nreq = json.load(sys.stdin)\nprint("working", file=sys.stderr)\njson.dump({"doubled": [v * 2 for v in req["values"]]}, sys.stdout)\n',
  );
  writeFileSync(
    join(pkg, "crash.py"),
    'import sys\nprint("about to fail", file=sys.stderr)\nsys.exit(3)\n',
  );
  writeFileSync(join(pkg, "chatty.py"), 'print("not json")\n');
  ready = makeReady();
}, 10 * 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("runPython", () => {
  test("round-trips JSON: stdin in, one document out, stderr to log", async () => {
    const lines: string[] = [];
    const out = await runPython(ready, {
      module: "fixture.echo",
      input: { values: [1, 2, 3] },
      output: z.object({ doubled: z.array(z.number()) }),
      timeoutMs: 30_000,
      log: (l) => lines.push(l),
    });
    expect(out).toEqual({ doubled: [2, 4, 6] });
    expect(lines).toEqual(["working"]);
  });

  test("a non-zero exit throws PythonEntryError with the stderr tail", async () => {
    const err = await runPython(ready, {
      module: "fixture.crash",
      input: {},
      output: z.unknown(),
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonEntryError);
    expect((err as PythonEntryError).exitCode).toBe(3);
    expect((err as PythonEntryError).stderrTail).toContain("about to fail");
  });

  test("stdout that is not one JSON document throws", async () => {
    const err = await runPython(ready, {
      module: "fixture.chatty",
      input: {},
      output: z.unknown(),
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PythonEntryError);
  });

  test("the output schema parses, never casts", async () => {
    const err = await runPython(ready, {
      module: "fixture.echo",
      input: { values: [1] },
      output: z.object({ doubled: z.array(z.string()) }),
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(z.ZodError);
  });
});
