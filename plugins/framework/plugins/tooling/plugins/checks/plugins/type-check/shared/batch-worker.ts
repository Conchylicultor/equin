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
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
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
import { readDeclaredUtilities } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { createLintEngine } from "./lint-engine";
import { runProgram, type DeclScope } from "./name-check";
import { createSourceFileCache } from "./name-host";
import { ProbeFs, RecordingResolver } from "./name-resolve";
import { openNameStore } from "./name-store";
import { openRepoView } from "./repo-view";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** A batch, with what every batch of its set shares (`./batch-processes.ts`). */
export interface BatchProcessJob extends BatchJob {
  root: AppPath;
  tree: TypeCheckTree;
  options: ts.CompilerOptions;
  /** Where this run's own `.d.ts` texts are, one file per hash. */
  spool: AppPath;
  declRoots: string[];
  globals: string[];
  declScopes: [string, DeclScope][];
  ambient: [string, readonly string[]][];
}

async function run(job: BatchProcessJob): Promise<BatchOutcome> {
  const view = await openRepoView(job.root, job.tree);
  const rel = (abs: string): string =>
    relative(job.root, abs).split("\\").join("/");
  const read = (abs: string): string => view.readText(rel(abs));
  const specs = Object.entries(job.lint).map(
    ([p, s]) => [join(job.root, p), s] as const,
  );
  const engine =
    specs.length > 0
      ? createLintEngine(job.root, readDeclaredUtilities(job.root))
      : undefined;
  // The syntactic groups FIRST, with no program: a program, once built, stays
  // alive to the process's exit and the collector paces the heap at a
  // multiple of it, so the same parses after it cost that multiple (the
  // worker's own `LintHook.beforeProgram`). Before it they run on a small heap
  // whose pages the program then reuses. The worker hands them here instead
  // of parsing every batched file itself (`./worker.ts`).
  const syntactic = new Map<string, BatchLintOut["syntactic"]>();
  for (const [abs, s] of specs) {
    if (s.unit === "split" && s.syntactic.length > 0) {
      syntactic.set(abs, await engine!.syntactic(abs, read(abs), s.syntactic));
    }
  }
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
        const spooled = joinAppPath(job.spool, h);
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
  for (const [abs, s] of specs) {
    lint[rel(abs)] = {
      typed:
        s.typed.length > 0
          ? await engine!.typed(program, abs, read(abs), s.unit, s.typed)
          : {},
      syntactic: syntactic.get(abs) ?? {},
    };
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

// The job file the spawning type-check wrote in its own spool dir.
const jobArg = process.argv[2];
if (!jobArg) {
  console.error("type-check batch: missing job file argument");
  process.exit(2);
}
const job = JSON.parse(
  readFileSync(asAppPath(jobArg), "utf8"),
) as BatchProcessJob;
const outcome = await run(job);
// Awaited to the last byte, because the exit below follows at once — and not
// a bare writeSync, which a non-blocking stdout pipe cuts short with EAGAIN
// or a short write (packages/blocking-write).
await Bun.write(Bun.stdout, JSON.stringify(outcome));
// Explicit: `exitWithParent`'s lifeline thread parks in a blocking FFI flock,
// which an emptied event loop must not wait on.
process.exit(0);
