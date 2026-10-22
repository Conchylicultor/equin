/**
 * The record phase (research/2026-10-21-global-type-check-two-programs.md,
 * and the run base: …-prepare-follows-the-change.md):
 *   1. with nothing recorded, every lintable file goes to the worker with its
 *      typed parts to decide (only the worker knows each file's result key),
 *      and `finalize` stores what came back under the keys the worker
 *      computed — and records the run base;
 *   2. the next run of the same tree carries every file from that base and
 *      sends none; a stored violation is still part of the verdict;
 *   3. after an edit, only the edited file is sent; the other carries;
 *   4. an unchanged tree is planned without reading a file or a store entry,
 *      and without loading the lint contributions (the type-aware groups are
 *      stored).
 *
 * The worker is not spawned: its outcome is written here, shaped exactly as
 * the protocol says. A real git fixture, because the tree is read from git.
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
import { computeTreeHash } from "@plugins/framework/plugins/tooling/plugins/checks/core";
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
  const treeHash = await computeTreeHash(root);
  if (treeHash === null) throw new Error(`no tree hash for ${root}`);
  const p = await openPreparation({ root, treeHash });
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
    const done = await first.finalize({
      tscClean: true,
      lint,
      keys: RESULT_KEYS,
      walkRoot: null,
    });
    expect(done.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(done.lintLine).toContain(
      "type-check: lint 2/2 files (2 whole, 0 partial; syntactic 2, typed 2;",
    );

    // 2. The same tree: every file carries from the base the first run
    //    recorded, so none is sent; the worker, whose keys did not move,
    //    answers nothing and keys nothing.
    const second = await prepare();
    expect(second.plan.lintFiles).toEqual([]);
    expect(second.plan.lintBase).not.toBeNull();
    expect(second.plan.baseLine).toContain("base this tree");
    // Nothing was read to plan it: every entry was found by version, and each
    // carries its directive flag. Nor were the contributions loaded: which
    // groups hold a type-aware rule was stored under the groups' fingerprints.
    const phases = (plan: Plan): string =>
      plan.phaseMs.map(([n]) => n).join("; ");
    expect(phases(first.plan)).toContain("type-aware groups loaded");
    expect(phases(first.plan)).toContain(
      "store reads, 2 entries, 2 texts read",
    );
    expect(phases(second.plan)).toContain("type-aware groups stored");
    expect(phases(second.plan)).toContain(
      "store reads, 0 entries, 0 texts read",
    );
    const again = await second.finalize({
      tscClean: true,
      lint: [],
      keys: {},
      walkRoot: null,
    });
    // 3. The stored violation is part of the verdict though nothing re-ran.
    expect(again.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(again.lintLine).toContain("type-check: lint 0/2 files");
  },
  TIMEOUT_MS,
);

test(
  "after an edit, a file whose result key did not move is reused, not re-linted",
  async () => {
    // Fix the violation. b's text changed, so b is sent with nothing known;
    // a's did not, so it carries from the base and is not sent at all.
    write("src/b.ts", 'import { a } from "./a";\nexport const b = a + 2;\n');
    const run = await prepare();
    expect(run.plan.lintFiles.map(relOf)).toEqual(["src/b.ts"]);
    const [jobB] = run.plan.lintFiles;
    if (jobB?.unit !== "split") throw new Error("expected b split");
    expect(jobB.typed.known).toEqual([]);
    // a's key did not move: no answer, no key. b ran.
    const done = await run.finalize({
      tscClean: true,
      keys: { "src/b.ts": RESULT_KEYS["src/b.ts"]! },
      walkRoot: null,
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
