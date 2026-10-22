/**
 * type-check's preparation runs on a Worker thread so the check runner's own
 * thread stays free. The move is only safe if it changes WHERE the work runs and
 * nothing else, so the cases below are:
 *   1. the plan the thread returns is the plan `openPreparation` computes
 *      in-process over the same tree — for a runnable tree and for one that
 *      fails the coverage gate;
 *   2. a throw inside `./prepare` rejects `prepare()` with the thread's own
 *      stack, rather than leaving the runner waiting on a thread that died;
 *   3. a finalize with no run plan behind it is refused loudly.
 *
 * The fixture is a real git repository, because the tree is read out of git.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  LINT_DATA_FILES,
  lintContributionPaths,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_BASE } from "../core";
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { openPreparation, type Plan, type PrepareInput } from "./prepare";
import { openPrepareThread } from "./prepare-thread";

// Spawning the thread evaluates the TypeScript compiler in it, which is seconds
// on a loaded host — well past bun's 5 s default.
const TIMEOUT_MS = 60_000;

let root = "";

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Run one git command in the fixture, failing loudly if it does not. */
async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${code}): ${await new Response(proc.stderr).text()}`,
    );
  }
}

// The fixture is a whole repo in miniature: a root `tsconfig.json` (the only
// tsconfig `repoProgram` ever names) whose `include` covers both sources.
const PROGRAM = "repo";

let dataRoot = "";
/** A real directory that is NOT a git checkout — the failing-root case below. */
let notARepo = "";
const priorDataRoot = process.env.SINGULARITY_DIR;

beforeAll(async () => {
  // The program name is a fixed literal now (`repo`), not a per-suite one, so
  // the host-global stores this preparation touches — the
  // lint result store — are the
  // REAL ones unless pointed
  // elsewhere. Left alone, the suite would score (and copy) every pooled
  // multi-GB base of every checkout on this machine. `SINGULARITY_DIR` is the
  // sanctioned redirect (every DataDir read resolves it per call), and it is
  // set before any worker is spawned so the thread inherits it too.
  dataRoot = mkdtempSync(join(tmpdir(), "type-check-prepare-thread-data-"));
  process.env.SINGULARITY_DIR = dataRoot;
  notARepo = mkdtempSync(join(tmpdir(), "type-check-prepare-thread-norepo-"));

  root = mkdtempSync(join(tmpdir(), "type-check-prepare-thread-"));
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  );
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", 'import { a } from "./a";\nexport const b = a + 1;\n');
  write("package.json", JSON.stringify({ name: "fixture" }));
  // The stylesheet class rules read their declared utilities from: part of
  // every lint rule group's key, so a tree without one cannot be planned.
  for (const rel of LINT_DATA_FILES) write(rel, "@utility fixture {}\n");
  await git("init", "-q");
  // So the host user's own global ignores cannot decide what the fixture holds.
  await git("config", "core.excludesFile", "/dev/null");
});

afterAll(() => {
  if (priorDataRoot === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = priorDataRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  if (notARepo) rmSync(notARepo, { recursive: true, force: true });
});

async function input(): Promise<PrepareInput> {
  const treeHash = await computeTreeHash(root);
  if (treeHash === null) throw new Error(`no tree hash for ${root}`);
  return { root, treeHash };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved or
 * rejected with a non-Error. (`expect(p).rejects.toThrow()` is typed `void`
 * under bun:test, so awaiting it trips `await-thenable`.)
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error rejection, got ${String(err)}`);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

test(
  "the thread's plan is the plan computed in-process",
  async () => {
    const thread = openPrepareThread();
    try {
      const fromThread = await thread.prepare(await input());
      const inProcess = (await openPreparation(await input())).plan;
      expect({ ...fromThread, phaseMs: [] }).toEqual({
        ...inProcess,
        phaseMs: [],
      });
      // Not a vacuous equality: the fixture is a runnable cold tree, whose
      // every file needs every syntactic rule group (the result store is
      // empty) and whose typed parts only the worker can decide.
      const everyGroup = [LINT_GROUP_BASE, ...lintContributionPaths()];
      const job = (rel: string) => ({
        file: join(root, rel),
        unit: "split" as const,
        syntactic: everyGroup,
        typed: { known: [] },
      });
      const expected: Plan = {
        kind: "run",
        program: { name: PROGRAM, tsconfigPath: join(root, "tsconfig.json") },
        lintFiles: [job("src/a.ts"), job("src/b.ts")],
        typedParts: {
          split: expect.any(Array) as { group: string; fp: string }[],
          whole: expect.any(Array) as { group: string; fp: string }[],
        },
        // No run was recorded yet, so no base: every file is sent.
        lintBase: null,
        // Nor a walk base bound to one: the worker's own last walk, if any.
        walkBase: { kind: "hint" },
        // The tree the thread was handed, and no overlay: nothing the
        // tsconfig includes is gitignored.
        tree: { treeHash: (await input()).treeHash, overlay: {} },
        phaseMs: expect.any(Array) as [string, number][],
        baseLine: expect.stringContaining("base none") as string,
      };
      expect(fromThread).toEqual(expected);
    } finally {
      thread.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "a coverage-gate failure crosses the thread as the same plan",
  async () => {
    // Outside the tsconfig include: not a root of the program, so nothing
    // type-checks or lints it.
    write("stray.ts", "export const stray = 1;\n");
    const thread = openPrepareThread();
    try {
      const fromThread = await thread.prepare(await input());
      expect(fromThread).toEqual((await openPreparation(await input())).plan);
      expect(fromThread).toEqual({
        kind: "uncovered",
        uncovered: ["stray.ts"],
      });
    } finally {
      thread.close();
      rmSync(join(root, "stray.ts"), { force: true });
    }
  },
  TIMEOUT_MS,
);

test(
  "a throw inside prepare rejects prepare() with the thread's own stack",
  async () => {
    const thread = openPrepareThread();
    try {
      // A tree that is not there: loading it fails loudly — inside
      // `./prepare`, on the thread.
      const err = await rejection(
        thread.prepare({ root: notARepo, treeHash: "0".repeat(40) }),
      );
      expect(err.message).toContain(notARepo);
      // A frame from inside `./prepare` — only the thread's own stack has one.
      expect(err.stack).toContain("openPreparation");
    } finally {
      thread.close();
    }
  },
  TIMEOUT_MS,
);

test(
  "finalize with no run plan behind it is refused",
  async () => {
    const thread = openPrepareThread();
    try {
      expect((await rejection(thread.finalize(undefined))).message).toContain(
        "finalize with no run plan",
      );
    } finally {
      thread.close();
    }
  },
  TIMEOUT_MS,
);
