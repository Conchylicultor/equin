/**
 * The record phase (research/2026-10-21-global-type-check-two-programs.md):
 *   1. every lintable file goes to the worker with its typed parts to decide
 *      (only the worker knows each file's result key), and `finalize` stores
 *      what came back under the keys the worker computed;
 *   2. the next run sends every file again, its syntactic groups fresh and its
 *      typed keys known; the worker answers `cached`, and a stored violation
 *      is still part of the verdict;
 *   3. after an edit, a file whose result key did not move is reused by the
 *      worker (`cached`), not re-linted.
 *
 * The worker is not spawned: its outcome is written here, shaped exactly as
 * the protocol says. A real git fixture, because the listing is read from git.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type {
  LintFileJob,
  LintFileResult,
  RawLintMessage,
  TypedPartOutcome,
} from "../core";
import { typedResultKey } from "../shared/keys";
import { readTreeListing } from "./fingerprint";
import { openPreparation, type Preparation } from "./prepare";

type Plan = Extract<Preparation, { finalize: unknown }>["plan"];

// Loading every lint contribution (to learn which groups are type-aware) and
// the TypeScript compiler is seconds on a loaded host.
const TIMEOUT_MS = 60_000;

let root = "";
let dataRoot = "";
const priorDataRoot = process.env.SINGULARITY_DIR;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

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

/** The result keys the worker would compute (`../shared/name-walk.ts`). */
const RESULT_KEYS: Record<string, string> = {
  "src/a.ts": "0123456789abcdef",
  "src/b.ts": "fedcba9876543210",
};

beforeAll(async () => {
  // The stores are host-global; `SINGULARITY_DIR` points them at a temp root.
  dataRoot = mkdtempSync(join(tmpdir(), "type-check-records-data-"));
  process.env.SINGULARITY_DIR = dataRoot;
  root = mkdtempSync(join(tmpdir(), "type-check-records-"));
  write(".gitignore", ".cache/\n");
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  );
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", 'import { a } from "./a";\nexport const b = a + 1;\n');
  write("package.json", JSON.stringify({ name: "fixture" }));
  for (const rel of LINT_DATA_FILES) write(rel, "@utility fixture {}\n");
  await git("init", "-q");
  await git("config", "core.excludesFile", "/dev/null");
});

afterAll(() => {
  if (priorDataRoot === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = priorDataRoot;
  if (root) rmSync(root, { recursive: true, force: true });
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

async function prepare(): Promise<Extract<Preparation, { finalize: unknown }>> {
  const p = await openPreparation({ listing: await readTreeListing(root) });
  if (!("finalize" in p)) throw new Error("expected a runnable plan");
  return p;
}

/** A split job's typed parts, each with the key the worker would compute. */
function typedKeys(plan: Plan, rel: string) {
  return plan.typedParts.split.map(({ group, fp }) => ({
    group,
    key: typedResultKey(fp, RESULT_KEYS[rel]!),
  }));
}

/** Every typed part of a job, run, with no messages. */
const ranAll = (plan: Plan, rel: string): TypedPartOutcome[] =>
  typedKeys(plan, rel).map((p) => ({ ...p, kind: "ran", messages: [] }));

const relOf = (job: LintFileJob): string => job.file.slice(root.length + 1);

const violation: RawLintMessage = {
  ruleId: "x/syntactic",
  fatal: false,
  line: 1,
  column: 1,
  message: "stored",
};

test(
  "a run's records answer the next run's syntactic groups, and its typed keys come back cached",
  async () => {
    // 1. Nothing stored: every part runs.
    const first = await prepare();
    expect(first.plan.lintFiles.map(relOf)).toEqual(["src/a.ts", "src/b.ts"]);
    for (const job of first.plan.lintFiles) expect(job.typed.known).toEqual([]);
    const lint: LintFileResult[] = first.plan.lintFiles.map((job) => {
      if (job.unit !== "split") throw new Error("expected split jobs");
      const rel = relOf(job);
      return {
        file: job.file,
        unit: "split",
        syntactic: Object.fromEntries(
          job.syntactic.map((g, i) => [
            g,
            rel === "src/b.ts" && i === 0 ? [violation] : [],
          ]),
        ),
        typed: ranAll(first.plan, rel),
      };
    });
    const done = await first.finalize({ tscClean: true, lint });
    expect(done.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(done.lintLine).toContain(
      "type-check: lint 2/2 files (2 whole, 0 partial; syntactic 2, typed 2;",
    );

    // 2. The same tree: every file sent again, every syntactic group fresh,
    //    every typed key known and newest — the worker reuses them all and
    //    answers nothing.
    const second = await prepare();
    for (const job of second.plan.lintFiles) {
      expect(job.syntactic).toEqual([]);
      expect([...job.typed.known].sort()).toEqual(
        typedKeys(second.plan, relOf(job))
          .map((p) => p.key)
          .sort(),
      );
    }
    const again = await second.finalize({ tscClean: true, lint: [] });
    // 3. The stored violation is part of the verdict though nothing re-ran.
    expect(again.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(again.lintLine).toContain("type-check: lint 0/2 files");
  },
  TIMEOUT_MS,
);

test(
  "after an edit, a file whose result key did not move is reused, not re-linted",
  async () => {
    // Fix the violation. b's text changed, so b's entry is new; a's did not,
    // so its syntactic groups are fresh and its typed keys known.
    write("src/b.ts", 'import { a } from "./a";\nexport const b = a + 2;\n');
    const run = await prepare();
    const [jobA, jobB] = run.plan.lintFiles;
    if (jobA?.unit !== "split" || jobB?.unit !== "split") {
      throw new Error("expected a and b split");
    }
    expect(jobA.syntactic).toEqual([]);
    expect(jobB.typed.known).toEqual([]);
    // a reused its newest keys: no answer. b ran.
    const done = await run.finalize({
      tscClean: true,
      lint: [
        {
          file: jobB.file,
          unit: "split",
          syntactic: Object.fromEntries(jobB.syntactic.map((g) => [g, []])),
          typed: ranAll(run.plan, "src/b.ts"),
        },
      ],
    });
    expect(done.lintViolations).toBe("");
    expect(done.lintLine).toContain(
      "type-check: lint 1/2 files (1 whole, 0 partial; syntactic 1, typed 1;",
    );
  },
  TIMEOUT_MS,
);
