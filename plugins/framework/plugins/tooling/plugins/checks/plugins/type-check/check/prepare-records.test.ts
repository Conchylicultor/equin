/**
 * The record phase closes the loop the signature table exists for
 * (research/2026-10-17-global-lint-keyed-on-what-it-reads.md §3):
 *   1. a first run on a program with no table defers every typed part to the
 *      worker, and `finalize` stores what came back under the keys the worker
 *      computed, plus the program's table and PASS;
 *   2. the next run on the SAME program decides every part in prepare — all
 *      fresh — and skips the worker outright;
 *   3. a syntactic group answered from the store on a run where the worker
 *      returns nothing for it is still part of the verdict;
 *   4. on a changed program a file whose typed key did not move is reused by
 *      the worker (`cached`), not re-linted.
 *
 * The worker is not spawned: its outcome is written here, shaped exactly as
 * the protocol says. A real git fixture, because the listing is read from git;
 * a hand-written buildinfo, because the program key enumerates the program
 * from one.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { LINT_DATA_FILES } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintFileResult, RawLintMessage } from "../core";
import { typedResultKey } from "../shared/type-fingerprint";
import { readTreeListing } from "./fingerprint";
import {
  openPreparation,
  type Preparation,
  type ProgramOutcome,
} from "./prepare";

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

const TYPE_FPS: Record<string, string> = {
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
  // What the program loaded, as the program key reads it: names only.
  write(
    ".cache/tsbuildinfo/repo.tsbuildinfo",
    JSON.stringify({
      fileNames: ["../../src/a.ts", "../../src/b.ts"],
      fileInfos: ["va", "vb"],
      version: "6.0.3",
    }),
  );
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
  const p = await openPreparation({
    listing: await readTreeListing(root),
    cacheEnabled: true,
  });
  if (!("finalize" in p)) throw new Error("expected a runnable plan");
  return p;
}

const violation: RawLintMessage = {
  ruleId: "x/syntactic",
  fatal: false,
  line: 1,
  column: 1,
  message: "stored",
};

test(
  "a run's records let the next run on the same program decide every part, and skip",
  async () => {
    // 1. No table yet: every typed part is deferred, so the worker must run.
    const first = await prepare();
    expect(first.plan.skipped).toBe(false);
    expect(first.plan.lintFiles.map((j) => j.typed.kind)).toEqual([
      "deferred",
      "deferred",
    ]);
    // The worker's answer: every syntactic group clean but one message on b,
    // every typed part run under the key it computes from the type fps.
    const lint: LintFileResult[] = first.plan.lintFiles.map((job) => {
      if (job.unit !== "split" || job.typed.kind !== "deferred") {
        throw new Error("expected split jobs with deferred typed parts");
      }
      const rel = job.file.slice(root.length + 1);
      return {
        file: job.file,
        unit: "split",
        syntactic: Object.fromEntries(
          job.syntactic.map((g, i) => [
            g,
            rel === "src/b.ts" && i === 0 ? [violation] : [],
          ]),
        ),
        typed: {
          kind: "ran",
          key: typedResultKey(job.typed.fp, TYPE_FPS[rel]!),
          messages: [],
        },
      };
    });
    const outcome: ProgramOutcome = {
      tscClean: true,
      lint,
      typeFps: { kind: "table", fps: TYPE_FPS },
    };
    const done = await first.finalize(outcome);
    expect(done.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(done.lintLine).toContain(
      "type-check: lint 2/2 files (2 whole, 0 partial; syntactic 2, typed 2; 2 sent;",
    );
    expect(done.lintLine).toContain(
      "typed keys from worker (no table for this program yet)",
    );

    // 2. The same program again: the table decides every typed part, the
    //    store answers every syntactic group — nothing is sent. The program did
    //    not PASS (a lint violation), so the worker still runs, with no files.
    const second = await prepare();
    expect(second.plan.lintFiles).toEqual([]);
    expect(second.plan.skipped).toBe(false);
    // 3. The stored violation is part of the verdict though nothing re-ran.
    const again = await second.finalize({
      tscClean: true,
      lint: [],
      typeFps: { kind: "table", fps: TYPE_FPS },
    });
    expect(again.lintViolations).toBe("src/b.ts:1:1  x/syntactic  stored");
    expect(again.lintLine).toContain("type-check: lint 0/2 files");
    expect(again.lintLine).toContain("typed keys from table");
  },
  TIMEOUT_MS,
);

test(
  "a changed program defers every typed part, the worker reuses what it can, and the next run skips",
  async () => {
    // Fix the violation. b's text changed, so b's entry is new; and a loaded
    // file's content is in the program key, so there is no table for this
    // program: a — its text, and so its syntactic results, unchanged — is sent
    // too, its typed part deferred with the key it already holds.
    write("src/b.ts", 'import { a } from "./a";\nexport const b = a + 2;\n');
    const run = await prepare();
    const [jobA, jobB] = run.plan.lintFiles;
    if (
      jobA?.unit !== "split" ||
      jobA.typed.kind !== "deferred" ||
      jobB?.unit !== "split" ||
      jobB.typed.kind !== "deferred"
    ) {
      throw new Error("expected a and b split, typed parts deferred");
    }
    expect([jobA.file, jobB.file]).toEqual([
      join(root, "src/a.ts"),
      join(root, "src/b.ts"),
    ]);
    const keyA = typedResultKey(jobA.typed.fp, TYPE_FPS["src/a.ts"]!);
    expect(jobA.syntactic).toEqual([]);
    expect(jobA.typed.known).toEqual([keyA]);
    expect(jobB.typed.known).toEqual([]);

    // a's type fingerprint did not move (a body edit in b cannot move it), so
    // the worker finds a's key among `known` and reuses it.
    const done = await run.finalize({
      tscClean: true,
      lint: [
        {
          file: jobA.file,
          unit: "split",
          syntactic: {},
          typed: { kind: "cached", key: keyA },
        },
        {
          file: jobB.file,
          unit: "split",
          syntactic: Object.fromEntries(jobB.syntactic.map((g) => [g, []])),
          typed: {
            kind: "ran",
            key: typedResultKey(jobB.typed.fp, TYPE_FPS["src/b.ts"]!),
            messages: [],
          },
        },
      ],
      typeFps: { kind: "table", fps: TYPE_FPS },
    });
    expect(done.lintViolations).toBe("");
    expect(done.lintLine).toContain(
      "type-check: lint 1/2 files (1 whole, 0 partial; syntactic 1, typed 1; 2 sent;",
    );

    // Clean, recorded, and the table under the program it built: nothing to
    // send, so nothing to run.
    const next = await prepare();
    expect(next.plan.lintFiles).toEqual([]);
    expect(next.plan.skipped).toBe(true);
    const skipped = await next.finalize(undefined);
    expect(skipped.lintViolations).toBe("");
    expect(skipped.lintLine).toContain("type-check: lint 0/2 files");
    expect(skipped.lintLine).toContain("typed keys from table");
  },
  TIMEOUT_MS,
);
