/**
 * One batch of the bounded whole check, in its own process
 * (`./batch-processes.ts`, research/2026-10-23-global-type-check-bounded-batches.md):
 * a program holding the batch's files as source, every other source file
 * served as the `.d.ts` the job names — this run's from the spool, the rest
 * from the host-wide store — then each file's lint inside that program, its
 * key left for the worker to decide.
 *
 * Protocol: argv[2] is a JSON job file. stdout is one `BatchOutcome`. A nonzero
 * exit means the batch itself crashed.
 */
import { existsSync, readFileSync, writeSync } from "fs";
import { join, relative } from "path";
import type ts from "typescript";
import { exitWithParent } from "@plugins/packages/plugins/flock/core";
import type { TypeCheckTree } from "../core";
import {
  ContractMissing,
  missingEdge,
  type BatchJob,
  type BatchLintOut,
  type BatchOutcome,
} from "./batch-run";
import { createLintEngine } from "./lint-engine";
import { runProgram, type DeclScope } from "./name-check";
import { createSourceFileCache } from "./name-host";
import { ProbeFs, RecordingResolver } from "./name-resolve";
import { openNameStore } from "./name-store";
import { openRepoView } from "./repo-view";

/** A batch, with what every batch of its set shares (`./batch-processes.ts`). */
export interface BatchProcessJob extends BatchJob {
  root: string;
  tree: TypeCheckTree;
  options: ts.CompilerOptions;
  /** Where this run's own `.d.ts` texts are, one file per hash. */
  spool: string;
  declRoots: string[];
  globals: string[];
  declScopes: [string, DeclScope][];
  ambient: [string, readonly string[]][];
}

async function run(job: BatchProcessJob): Promise<BatchOutcome> {
  const view = await openRepoView(job.root, job.tree);
  const store = openNameStore();
  const resolver = new RecordingResolver(new ProbeFs(view), job.options);
  let program: ts.Program;
  let done: ReturnType<typeof runProgram>;
  try {
    done = runProgram({
      view,
      options: job.options,
      sources: new Set(job.sources),
      check: new Set(job.check),
      declRoots: job.declRoots,
      globals: job.globals,
      declScopes: new Map(job.declScopes),
      ambient: new Map(job.ambient),
      contractOf: (p) => {
        const h = job.contracts[p];
        if (h === undefined) throw missingEdge(p, job);
        const spooled = join(job.spool, h);
        if (existsSync(spooled)) return readFileSync(spooled, "utf8");
        const text = store.readContract(h);
        if (text === undefined) throw new ContractMissing(p);
        return text;
      },
      cache: createSourceFileCache(),
      resolver,
    });
    program = done.program;
  } catch (err) {
    if (err instanceof ContractMissing) {
      return { kind: "contract-missing", path: err.path };
    }
    throw err;
  }
  const lint: Record<string, BatchLintOut> = {};
  const specs = Object.entries(job.lint);
  if (specs.length > 0) {
    const engine = createLintEngine(job.root);
    const rel = (abs: string): string =>
      relative(job.root, abs).split("\\").join("/");
    const out = await engine.files(
      program,
      new Map(specs.map(([p, s]) => [join(job.root, p), s])),
      (abs) => view.readText(rel(abs)),
    );
    for (const [abs, o] of out) lint[rel(abs)] = o;
  }
  return {
    kind: "done",
    checked: Object.fromEntries(done.checked),
    served: Object.fromEntries(done.served),
    programDiagnostics: done.programDiagnostics,
    stats: done.stats,
    lint,
  };
}

// A multi-GB process whose only reader is the worker that spawned it: when that
// worker dies, this must die too.
exitWithParent();

const jobPath = process.argv[2];
if (!jobPath) {
  console.error("type-check batch: missing job file argument");
  process.exit(2);
}
const job = JSON.parse(readFileSync(jobPath, "utf8")) as BatchProcessJob;
const outcome = await run(job);
// Synchronous, because the exit below follows at once.
writeSync(1, JSON.stringify(outcome));
// Explicit: `exitWithParent`'s lifeline thread parks in a blocking FFI flock,
// which an emptied event loop must not wait on.
process.exit(0);
