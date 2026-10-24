import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineDep,
  depState,
  ensureDep,
  readyNow,
} from "@plugins/infra/plugins/deps/deps";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { build, builtFile, type BuildContext } from "./build";

let root: string;
let store: { cacheRoot: string; locksRoot: string };
const exec = execContextForTests();

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "deps-build-test-"));
  root = join(base, "repo");
  store = { cacheRoot: join(base, "cache"), locksRoot: join(base, "locks") };
  mkdirSync(join(root, "native"), { recursive: true });
  // A real repo: the kind lists its inputs with `git ls-files` (untracked
  // files count, so nothing needs committing).
  const git = spawnSync("git", ["init", "-q", root]);
  expect(git.status).toBe(0);
  writeFileSync(join(root, "native", "a.c"), "int a;\n");
});
afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }));

/** A "compiler" that concatenates the inputs into the output. */
async function concat(ctx: BuildContext): Promise<void> {
  await ctx.run(["sh", "-c", `cat native/*.c > "$0"`, ctx.output], {
    cwd: ctx.root,
    env: { ...process.env },
    timeoutMs: 10_000,
  });
}

function dep(source: ReturnType<typeof build>) {
  return defineDep({
    id: "build-test",
    owner: "infra/deps/build",
    description: "",
    sizeHint: "",
    source,
    updates: { none: "built from this checkout's own source" },
  });
}

const tool = { versionArgv: ["echo", "tool 1.0"] };

describe("build", () => {
  test("builds the output into env/, at the path builtFile names", async () => {
    const d = dep(
      build({ inputs: ["native/**"], tool, output: "out.bin", run: concat }),
    );
    const ready = await ensureDep(d, exec, { store, root });
    expect(builtFile(ready)).toBe(join(ready.dir, "out.bin"));
    expect(readFileSync(builtFile(ready), "utf8")).toBe("int a;\n");

    // The output is what "intact" means: losing it reads as absent.
    rmSync(builtFile(ready));
    expect((await readyNow(d, { store, root })).kind).toBe("absent");
  });

  test("a changed input file, a new file or a new tool is a new identity", async () => {
    const identity = async (versionArgv = tool.versionArgv) =>
      build({
        inputs: ["native/**"],
        tool: { versionArgv },
        output: "out.bin",
        run: concat,
      }).identityInputs(root);

    const before = await identity();
    expect(Object.keys(before).sort()).toEqual([
      "file:native/a.c",
      "target",
      "tool",
    ]);
    expect(before.tool).toBe("tool 1.0");
    expect(before.target).toBe(`${process.platform}/${process.arch}`);

    writeFileSync(join(root, "native", "a.c"), "int a = 1;\n");
    const edited = await identity();
    expect(edited["file:native/a.c"]).not.toBe(before["file:native/a.c"]);

    writeFileSync(join(root, "native", "b.c"), "int b;\n");
    expect(Object.keys(await identity())).toContain("file:native/b.c");

    expect((await identity(["echo", "tool 2.0"])).tool).toBe("tool 2.0");
  });

  test("an edit rebuilds beside the old install", async () => {
    const d = dep(
      build({ inputs: ["native/**"], tool, output: "out.bin", run: concat }),
    );
    const first = await ensureDep(d, exec, { store, root });
    writeFileSync(join(root, "native", "a.c"), "int a = 2;\n");
    const second = await ensureDep(d, exec, { store, root });
    expect(second.identity).not.toBe(first.identity);
    expect(readFileSync(builtFile(second), "utf8")).toBe("int a = 2;\n");
  });

  test("a failing build is recorded as failed", async () => {
    const d = dep(
      build({
        inputs: ["native/**"],
        tool,
        output: "out.bin",
        run: async (ctx) =>
          ctx.run(["sh", "-c", "echo 'error: no such header' >&2; exit 1"], {
            cwd: ctx.root,
            env: { ...process.env },
            timeoutMs: 10_000,
          }),
      }),
    );
    const err = await ensureDep(d, exec, { store, root }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("no such header");
    const state = await depState(d, { store, root });
    expect(state.kind).toBe("failed");
  });

  test("a build that leaves no output fails", async () => {
    const d = dep(
      build({
        inputs: ["native/**"],
        tool,
        output: "out.bin",
        run: async () => {},
      }),
    );
    const err = await ensureDep(d, exec, { store, root }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("without producing");
  });

  test("then runs on the produced output, and a throw in it fails the install", async () => {
    const seen: string[] = [];
    const signed = dep(
      build({
        inputs: ["native/**"],
        tool,
        output: "out.bin",
        run: concat,
        then: async (ctx, built) => {
          expect(built).toBe(ctx.output);
          seen.push(built);
          writeFileSync(built, "signed\n");
        },
      }),
    );
    const ready = await ensureDep(signed, exec, { store, root });
    expect(seen).toEqual([builtFile(ready)]);
    expect(readFileSync(builtFile(ready), "utf8")).toBe("signed\n");

    // Not part of the identity: the same build without `then` is the same install.
    const plain = dep(
      build({ inputs: ["native/**"], tool, output: "out.bin", run: concat }),
    );
    expect((await readyNow(plain, { store, root })).kind).toBe("ready");

    writeFileSync(join(root, "native", "a.c"), "int a = 3;\n");
    const failing = dep(
      build({
        inputs: ["native/**"],
        tool,
        output: "out.bin",
        run: concat,
        then: async () => {
          throw new Error("no signing identity");
        },
      }),
    );
    const err = await ensureDep(failing, exec, { store, root }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("no signing identity");
    expect((await depState(failing, { store, root })).kind).toBe("failed");
  });

  test("a missing tool or an input glob matching nothing is failed, not absent", async () => {
    const noTool = dep(
      build({
        inputs: ["native/**"],
        tool: { versionArgv: ["false"] },
        output: "out.bin",
        run: concat,
      }),
    );
    expect((await depState(noTool, { store, root })).kind).toBe("failed");

    const noInput = dep(
      build({ inputs: ["missing/**"], tool, output: "out.bin", run: concat }),
    );
    const state = await depState(noInput, { store, root });
    expect(state.kind === "failed" && state.message).toContain(
      "matches no file",
    );
  });

  test("rejects a malformed declaration at definition time", () => {
    const run = concat;
    expect(() => build({ inputs: [], tool, output: "o", run })).toThrow(
      "at least one input",
    );
    expect(() => build({ inputs: ["../x"], tool, output: "o", run })).toThrow(
      "relative to the repo root",
    );
    expect(() => build({ inputs: ["x"], tool, output: "a/b", run })).toThrow(
      "must match",
    );
  });
});

describe("targets", () => {
  const host = { platform: process.platform, arch: process.arch };
  const foreign = {
    platform: (process.platform === "linux"
      ? "darwin"
      : "linux") as NodeJS.Platform,
    arch: "x64",
  };

  /** A "compiler" that writes the target it was asked for. */
  const writeTarget = async (ctx: BuildContext) =>
    ctx.run(
      [
        "sh",
        "-c",
        `printf %s "$1" > "$0"`,
        ctx.output,
        `${ctx.target.platform}/${ctx.target.arch}`,
      ],
      { cwd: ctx.root, env: { ...process.env }, timeoutMs: 10_000 },
    );

  test("forTarget passes the target to run, names it in the identity and in the output", async () => {
    const source = build({
      inputs: ["native/**"],
      tool,
      output: (t) => `out.${t.platform}`,
      targets: "any",
      run: writeTarget,
    });
    expect(source.output).toBe(`out.${host.platform}`);
    const targeted = source.forTarget(foreign);
    if (!targeted.ok) throw new Error(targeted.reason);
    const inputs = await targeted.source.identityInputs(root);
    expect(inputs.target).toBe(`${foreign.platform}/${foreign.arch}`);
    expect((await source.identityInputs(root)).target).toBe(
      `${host.platform}/${host.arch}`,
    );

    const dir = join(root, "..", "sealed-env");
    await targeted.source.install({
      root,
      dir,
      log: () => {},
      exec,
      run: async (argv, opts) => {
        const r = spawnSync(argv[0] as string, argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env as NodeJS.ProcessEnv,
        });
        expect(r.status).toBe(0);
      },
    });
    expect(readFileSync(join(dir, `out.${foreign.platform}`), "utf8")).toBe(
      `${foreign.platform}/${foreign.arch}`,
    );
  });

  test("a build that never said it cross-compiles refuses a foreign target, honestly", () => {
    const hostOnly = build({
      inputs: ["native/**"],
      tool,
      output: "o",
      run: concat,
    });
    expect(hostOnly.forTarget(host).ok).toBe(true);
    const refused = hostOnly.forTarget(foreign);
    expect(!refused.ok && refused.reason).toContain("host only");

    const perTarget = build({
      inputs: ["native/**"],
      tool,
      output: "o",
      run: concat,
      targets: () => ({ ok: false, reason: "no cross sysroot" }),
    });
    const no = perTarget.forTarget(foreign);
    expect(!no.ok && no.reason).toBe("no cross sysroot");
  });
});
