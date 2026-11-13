// The schema question host (`askSchemaFiles`, core/internal/schema-question.ts):
// loads every schema file the way drizzle-kit does — a synchronous `require()`
// each, in path order, in this one process, under `bun --bun`, from the
// migrations plugin's dir — then asks each question module about each file
// that loaded.
//
// Run as: bun --bun schema-question-host.ts <checkout root>, with
// `{ files, asks: { question, inputs }[] }` on stdin; writes
// `{ loadFailures, answers }` to stdout, one answer per ask in request order.
// `files` are repo-relative to the checkout root (the data); each `question`
// is an absolute module path (code, run from the checkout it lives in). Every
// path out is repo-relative: each answer is a record every checkout shares.
//
// Every file loads first, and only then is a question module loaded and
// asked: a registry a schema file's module eval fills (derived updatedAt, id
// columns) is complete when a question reads it, and a question's own imports
// cannot change the order schema modules first evaluate in. A question that
// throws fails its own ask, never another's.
//
// Imports only builtins on purpose: this module is in every answer's key.
import { join } from "node:path";

interface Request {
  files: string[];
  asks: { question: string; inputs: Record<string, unknown> }[];
}
interface Question {
  answer(
    file: string,
    exports: Record<string, unknown>,
    input: unknown,
  ): unknown;
}

const root = process.argv[2];
if (root === undefined)
  throw new Error(
    "schema-question-host: the checkout root is its first argument",
  );
const request = JSON.parse(await Bun.stdin.text()) as Request;

// An error names files by absolute path, as given or resolved through a
// symlink: a record names no checkout. The resolved root is read off the cwd
// (the migrations plugin's dir, which the OS reports resolved).
const MIGRATIONS_DIR = "plugins/database/plugins/migrations";
const cwd = process.cwd();
if (!cwd.endsWith(`/${MIGRATIONS_DIR}`))
  throw new Error(
    `schema-question-host: run from ${MIGRATIONS_DIR}, not ${cwd}`,
  );
const resolvedRoot = cwd.slice(0, -MIGRATIONS_DIR.length - 1);
// The checkout this host (and so the question code) runs from, which an
// error may name too: this script's own dir, less its place in the repo.
const OWN_DIR = `${MIGRATIONS_DIR}/plugins/schema-question/scripts`;
if (!import.meta.dir.endsWith(`/${OWN_DIR}`))
  throw new Error(
    `schema-question-host: expected to live in ${OWN_DIR}, not ${import.meta.dir}`,
  );
const ownRoot = import.meta.dir.slice(0, -OWN_DIR.length - 1);
const roots = [...new Set([root, resolvedRoot, ownRoot])]
  .map((r) => `${r}/`)
  // Longest first: a worktree's root sits inside main's.
  .sort((a, b) => b.length - a.length);
const relative = (text: string): string =>
  roots.reduce((t, r) => t.split(r).join(""), text);

const modules = new Map<string, Record<string, unknown>>();
const loadFailures: Record<string, string> = {};
for (const file of request.files) {
  try {
    modules.set(file, require(join(root, file)) as Record<string, unknown>);
  } catch (e) {
    loadFailures[file] = relative(String(e));
  }
}

const answers = request.asks.map((ask) => {
  try {
    const question = (require(ask.question) as { default: Question }).default;
    const files: Record<string, unknown> = {};
    for (const [file, exports] of modules)
      files[file] = question.answer(file, exports, ask.inputs[file] ?? null);
    return { ok: true, files };
  } catch (e) {
    return {
      ok: false,
      error: relative(e instanceof Error ? (e.stack ?? String(e)) : String(e)),
    };
  }
});

process.stdout.write(JSON.stringify({ loadFailures, answers }));
