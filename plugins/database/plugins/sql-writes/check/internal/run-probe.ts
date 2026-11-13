import { askSchemaFiles } from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import { IMPERATIVE_PUBLIC_TABLES } from "@plugins/database/plugins/derived-views/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type {
  FileRef,
  ProbeFileAnswer,
  ProbeInput,
  ProbeOutput,
  ProbeTable,
  ResolvedRef,
} from "./probe-types";

export type ProbeResult =
  | ({ readonly kind: "ok" } & ProbeOutput)
  | { readonly kind: "probe-failed"; readonly message: string };

const QUESTION = new URL("./schema.question.ts", import.meta.url).href;

/**
 * The database the code declares: `schema.question.ts` asked of every schema
 * file by the schema question host (`askSchemaFiles`), which loads them the
 * way drizzle-kit does — a record keyed by every schema file's closure and the
 * refs asked, so a pass whose edit reaches no schema file is a lookup —
 * assembled here: a table exported by two
 * files is the first file's, and the imperative public tables are read in
 * this process (plain data, `derived-views/core`).
 */
export async function runSchemaProbe(
  repo: RepoFiles,
  input: ProbeInput,
): Promise<ProbeResult> {
  const refsOf = new Map<string, FileRef[]>();
  for (const { file, ...ref } of input.refs)
    refsOf.set(file, [...(refsOf.get(file) ?? []), ref]);
  const probe = await askSchemaFiles<ProbeFileAnswer, readonly FileRef[]>(
    repo,
    {
      name: "sql-writes:schema-probe",
      module: QUESTION,
      files: input.files,
      input: (file) => refsOf.get(file) ?? [],
    },
  );
  if (probe.kind === "probe-failed") return probe;

  const tables = new Map<string, ProbeTable>();
  const refs: Record<string, ResolvedRef> = {};
  const loadFailures: { file: string; error: string }[] = [];
  for (const [file, answer] of probe.answers) {
    if (answer.kind === "load-failed") {
      loadFailures.push({ file, error: answer.error });
      continue;
    }
    for (const t of answer.answer.tables) {
      const key = `${t.schema}.${t.name}`;
      if (!tables.has(key)) tables.set(key, t);
    }
    Object.assign(refs, answer.answer.refs);
  }
  // A ref into a file that did not load (or is no schema file) evaluates to nothing.
  for (const ref of input.refs)
    refs[ref.id] ??= {
      kind: "other",
      what: "a module the probe did not load",
    };
  return {
    kind: "ok",
    tables: [...tables.values()],
    imperative: Object.values(IMPERATIVE_PUBLIC_TABLES),
    refs,
    loadFailures,
  };
}
