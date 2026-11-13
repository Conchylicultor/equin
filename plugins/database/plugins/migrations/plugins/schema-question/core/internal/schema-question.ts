import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  closureRecord,
  repoModuleOf,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  MIGRATIONS_PLUGIN_DIR,
  schemaFilesIn,
} from "@plugins/database/plugins/migrations/core";

/**
 * A question about what loading one schema file yields, asked in the process
 * that loads the schema files the way drizzle-kit does (`askSchemaFiles`). It
 * is a module's DEFAULT export — `export default { answer } satisfies
 * SchemaQuestion<A, I>` — which the probe host `require()`s after every
 * schema file has loaded (so a registry their module eval fills is complete),
 * and calls once per file that loaded.
 *
 * `answer` returns plain JSON, with repo-relative paths only (the answer is a
 * record every checkout shares). Import what it reads through the SAME
 * specifiers the schema files use, so the host holds one instance of each
 * module.
 */
export interface SchemaQuestion<A, I = null> {
  answer(file: string, exports: Record<string, unknown>, input: I): A;
}

/** What one schema file answered: the question's answer, or the error its load threw. */
export type SchemaFileAnswer<A> =
  | { readonly kind: "loaded"; readonly answer: A }
  | { readonly kind: "load-failed"; readonly error: string };

export type SchemaAnswers<A> =
  | {
      readonly kind: "ok";
      /** Every asked file's answer, in the order asked. */
      readonly answers: ReadonlyMap<string, SchemaFileAnswer<A>>;
      /** True when the probe host ran (no record held the answer). */
      readonly computed: boolean;
    }
  | { readonly kind: "probe-failed"; readonly message: string };

// The host's wire format (`scripts/schema-question-host.ts` spells it again:
// it imports nothing, being in every answer's key).
interface HostRequest {
  files: string[];
  asks: { question: string; inputs: Record<string, unknown> }[];
}
interface HostResponse {
  loadFailures: Record<string, string>;
  /** Per ask, in request order: each loaded file's answer, or why the question threw. */
  answers: (
    { ok: true; files: Record<string, unknown> } | { ok: false; error: string }
  )[];
}

// The host's repo-relative path: fixed by this plugin's layout, whatever the
// checkout (a test's throwaway root holds it at the same place).
const HOST_MODULE = `${MIGRATIONS_PLUGIN_DIR}/plugins/schema-question/scripts/schema-question-host.ts`;
const HOST_URL = new URL(
  "../../scripts/schema-question-host.ts",
  import.meta.url,
).href;
if (!HOST_URL.endsWith(`/${HOST_MODULE}`))
  throw new Error(
    `schema-question: the probe host is not at ${HOST_MODULE} (${HOST_URL})`,
  );

type Outcome =
  | { kind: "ok"; answers: Record<string, SchemaFileAnswer<unknown>> }
  | { kind: "probe-failed"; message: string };

interface Ask {
  question: string;
  inputs: Record<string, unknown>;
  outcome?: Outcome;
}

/** A batch's identity: one checkout's root and one exact file set. */
interface Batch {
  root: string;
  files: readonly string[];
}

/**
 * Every miss of one checkout over one file set, folded into as few probe
 * processes as possible: the checks of a pass ask at different moments, so
 * the first miss starts a process at once and every miss arriving while it
 * runs joins ONE trailing process — at most two loads of the schema files per
 * burst, however many questions. Asks over different file sets never share a
 * process: each answer is keyed by exactly the set loaded with it.
 */
const batches = new Map<string, Batch>();
const probes = createKeyedCoalescer<string, Ask>({
  run: async (batchKey, asks) => {
    const { root, files } = batches.get(batchKey)!;
    const request: HostRequest = {
      files: [...files],
      asks: asks.map((a) => ({ question: a.question, inputs: a.inputs })),
    };
    const result = await spawnCaptured(
      [process.execPath, "--bun", `${root}/${HOST_MODULE}`, root],
      {
        // drizzle-kit's cwd and environment: a schema file loads here exactly
        // as migration generation loads it.
        cwd: `${root}/${MIGRATIONS_PLUGIN_DIR}`,
        env: { ...process.env, NO_COLOR: "1" },
        stdin: JSON.stringify(request),
        // Seconds of module loading; three minutes only bounds a schema file
        // whose module scope never returns.
        timeoutMs: 180_000,
      },
    );
    let response: HostResponse;
    try {
      if (result.exitCode !== 0)
        throw new Error(`exit code ${result.exitCode}`);
      response = JSON.parse(result.stdout) as HostResponse;
      if (response.answers.length !== asks.length)
        throw new Error(
          `${response.answers.length} answers for ${asks.length} questions`,
        );
    } catch (err) {
      const message =
        `schema question probe failed (${String(err)}).\n` +
        `exit code: ${result.exitCode}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout.slice(0, 4000)}`;
      for (const a of asks) a.outcome = { kind: "probe-failed", message };
      return;
    }
    asks.forEach((a, i) => {
      const own = response.answers[i]!;
      if (!own.ok) {
        a.outcome = {
          kind: "probe-failed",
          message: `schema question ${a.question} threw in the probe host: ${own.error}`,
        };
        return;
      }
      const answers: Record<string, SchemaFileAnswer<unknown>> = {};
      for (const file of files) {
        const error = response.loadFailures[file];
        answers[file] =
          error !== undefined
            ? { kind: "load-failed", error }
            : { kind: "loaded", answer: own.files[file] };
      }
      a.outcome = { kind: "ok", answers };
    });
  },
});

/**
 * Ask `question` (the URL of its module — `new URL("./q.ts",
 * import.meta.url).href`) about every schema-glob file of `repo` (or `files`),
 * loaded by the probe host the way drizzle-kit loads them: `require()` each,
 * in path order, in ONE process, under `bun --bun`, from the migrations
 * plugin's dir with drizzle-kit's environment.
 *
 * The answer — every file's — is ONE plugin record (`closureRecord`), keyed by
 * the Merkle keys of the probe host, the question module and every asked file
 * (each over its import closure), plus the inputs. Not one record per file:
 * the files share a process, and so their module eval shares registries — a
 * table declared twice throws in whichever file loads second — so a file's
 * answer is a function of the whole set loaded with it, as it is for
 * drizzle-kit. So a pass after an edit no schema file's closure reaches is a
 * lookup (64% of 400 main commits), and every question that misses in a pass
 * shares one load (see `probes`).
 *
 * A load failure is a file's answer; a probe that did not answer (a crash, a
 * timeout, a question that threw) is `probe-failed` and stores nothing.
 */
export async function askSchemaFiles<A, I = null>(
  repo: RepoFiles,
  question: {
    /** What is asked, part of the record key. */
    name: string;
    /** The question module's URL (`import.meta.url`-relative). */
    module: string;
    /** The files to ask about (default: every schema-glob file of `repo`). */
    files?: readonly string[];
    /** Each file's input (plain JSON, part of the key). Default null. */
    input?: (file: string) => I;
  },
): Promise<SchemaAnswers<A>> {
  const files = [...(question.files ?? schemaFilesIn(repo))].sort();
  const questionModule = repoModuleOf(repo, question.module);
  const inputs: Record<string, unknown> = {};
  for (const f of files) inputs[f] = question.input?.(f) ?? null;
  const record = await closureRecord<
    Record<string, SchemaFileAnswer<A>>,
    string
  >(
    repo,
    {
      name: `schema-question:${question.name}`,
      modules: [HOST_MODULE, questionModule, ...files],
      input: { files, inputs },
    },
    async () => {
      const batchKey = `${repo.root}\0${files.join("\0")}`;
      batches.set(batchKey, { root: repo.root, files });
      const ask: Ask = { question: questionModule, inputs };
      await probes.run(batchKey, [ask]);
      const outcome = ask.outcome;
      if (outcome === undefined)
        throw new Error("schema question probe settled without an answer");
      return outcome.kind === "ok"
        ? {
            ok: true,
            value: outcome.answers as Record<string, SchemaFileAnswer<A>>,
          }
        : { ok: false, error: outcome.message };
    },
  );
  if (!record.ok) return { kind: "probe-failed", message: record.error };
  return {
    kind: "ok",
    answers: new Map(files.map((f) => [f, record.value[f]!])),
    computed: !record.hit,
  };
}

/**
 * Every asked file's answer, split into the files that loaded (with their
 * answer) and the ones whose load threw — in path order.
 */
export function splitSchemaAnswers<A>(
  answers: ReadonlyMap<string, SchemaFileAnswer<A>>,
): {
  loaded: [file: string, answer: A][];
  loadFailures: { file: string; error: string }[];
} {
  const loaded: [string, A][] = [];
  const loadFailures: { file: string; error: string }[] = [];
  for (const [file, a] of answers) {
    if (a.kind === "loaded") loaded.push([file, a.answer]);
    else loadFailures.push({ file, error: a.error });
  }
  return { loaded, loadFailures };
}

/**
 * Each table named by a per-file list of table names, with the first file (in
 * path order) naming it — a table re-exported by two schema files is reported
 * once — sorted by table name.
 */
export function firstFileOfEachTable(
  loaded: readonly (readonly [file: string, tables: readonly string[]])[],
): { table: string; file: string }[] {
  const first = new Map<string, string>();
  for (const [file, tables] of loaded)
    for (const t of tables) if (!first.has(t)) first.set(t, file);
  return [...first]
    .map(([table, file]) => ({ table, file }))
    .sort((a, b) => a.table.localeCompare(b.table));
}
