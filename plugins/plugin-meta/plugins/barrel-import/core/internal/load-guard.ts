import { installFsCallGuard } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { dataRootLayout } from "@plugins/infra/plugins/paths/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * A barrel loads as a function of its code and of the declared load inputs
 * ({@link barrelLoadInputs}): while the modules a barrel import evaluates run
 * their top level, any other read of a file (any `timed-fs` call), of the
 * environment (`process.env`) or of the working directory throws.
 *
 * Why: plugin-records stores what importing a barrel produced under the
 * barrel's module Merkle key — its code, the evaluator's, the runtime, the
 * lockfile and the load inputs. Any other load-time read is an input no key
 * names, so a record made from one would be served stale to every checkout
 * until the daily verifier recomputed it. Refusing the read makes such a
 * record impossible to make, the same way a facet's strict snapshot refuses a
 * read outside its plugin's files.
 *
 * Every barrel import is guarded, not only a record's: a module evaluates once
 * per process, under whichever import reached it first, so a read let through
 * for one caller would be baked into the record another makes later.
 *
 * The span: each import goes through a generated wrapper whose first
 * dependency opens the span and whose last closes it. ESM evaluates a graph's
 * new modules depth-first, synchronously, so the span holds exactly the
 * top-level code of the modules this import evaluates — never the work of a
 * concurrent check that runs while the import is loading files. A module with
 * a top-level await suspends its graph, and `leave` (which does not depend on
 * it) runs then: the span closes rather than staying open over other code, and
 * the top-level code after the await runs unguarded (no plugin module has one). A module whose evaluation throws leaves the span
 * open; {@link guardedImport} closes it however the import settles.
 *
 * Not covered (the daily `plugin-records.verify` job still catches them):
 * `Bun.env` / `import.meta.env` (not replaceable in Bun), untimed reads (a
 * `node:fs` import the `timed-fs/no-untimed-fs-read` lint does not see, or
 * `Bun.file`), other host reads (`os.homedir`, a spawn), a read a package
 * makes ({@link check}), and a module that was evaluated before the first
 * barrel import (by the process's own imports).
 */

/**
 * What a barrel may read as it loads, because every evaluated record's key
 * names its value ({@link barrelLoadInputs}, folded into plugin-records'
 * evaluator identity):
 *
 * - `NODE_ENV` — React picks its build by it as it evaluates;
 * - the data root and its override, `EQUIN_DIR` — every data dir's path is
 *   resolved from it, and path constants are frozen at import by design
 *   (`database/embedded`'s cluster dir);
 * - `EQUIN_PG_PORT` / `EQUIN_PG_SOCKET_DIR` — the cluster's address, and
 *   `EQUIN_MIGRATIONS_DIR` — a release's vendored migrations: the same kind of
 *   import-frozen constant, set by the launcher before anything loads.
 *
 * Each is a fact of the machine or the install, the same for every process
 * sharing a record store, so naming it costs no hit. Anything else a barrel
 * needs from its host it reads at run time.
 */
const LOAD_ENV: ReadonlySet<string> = new Set([
  "NODE_ENV",
  envName("DIR"),
  envName("PG_PORT"),
  envName("PG_SOCKET_DIR"),
  envName("MIGRATIONS_DIR"),
]);

/**
 * The values of what a barrel may read as it loads, one `name=value` each —
 * part of every evaluated record's key. Read outside any span: the data root's
 * home layout (a disk read) is decided here, once per process, so a module
 * that resolves a data dir at load reads what this names.
 */
export function barrelLoadInputs(): string[] {
  const env = realEnv ?? process.env;
  return [
    ...[...LOAD_ENV].sort().map((k) => `${k}=${env[k] ?? ""}`),
    `dataRoot=${dataRootLayout().root}`,
  ];
}

/** Thrown for a read inside a barrel load's span. */
export class BarrelLoadReadError extends Error {
  override name = "BarrelLoadReadError";
}

const NAMESPACE = "equin-barrel-load";
const SELF = fileURLToPath(import.meta.url);

/** Barrels a guarded import already evaluated: their modules never run again. */
const evaluated = new Set<string>();
/** The barrel each pending import loads, by its wrapper id. */
const pending = new Map<number, string>();
let nextId = 0;
let inputsResolved = false;
/** The import whose span is open. */
let open: { id: number; barrel: string } | null = null;
let realEnv: NodeJS.ProcessEnv | null = null;
let realCwd: (() => string) | null = null;

/**
 * The file of the innermost stack frame that is neither this guard, timed-fs,
 * nor a runtime builtin: the code that made the read.
 */
function readerFile(): string | undefined {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const m = /(?:\(|at )(\/.+):\d+:\d+\)?$/.exec(line.trim());
    if (!m) continue;
    const file = m[1]!;
    if (file === SELF || file.endsWith("/timed-fs/core/internal/timed-fs.ts"))
      continue;
    return file;
  }
  return undefined;
}

/**
 * Refuses a read inside the open span — unless a package made it: a package's
 * code is pinned by the lockfile in the key, and how it probes its host as it
 * loads (colour support, the terminal, its own debug switches) is not the
 * repo's to change. Not covered either, like the gaps above.
 */
function check(what: string): void {
  const file = readerFile();
  if (file?.includes("/node_modules/")) return;
  const barrel = open ? relative(REPO_ROOT, open.barrel) : "?";
  const at = file ? ` by ${relative(REPO_ROOT, file)}` : "";
  throw new BarrelLoadReadError(
    `[barrel-import] ${what}${at} while the modules of ${barrel} were evaluating. ` +
      "A barrel's evaluated record (plugin-records) is keyed by its code and the declared load inputs only, so any other load-time read is an input no key names: " +
      "read it inside a function called at run time instead of at module top level.",
  );
}

function guardedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const read = (key: string | symbol): void => {
    if (typeof key === "symbol" || LOAD_ENV.has(key)) return;
    check(`process.env.${key} was read`);
  };
  return new Proxy(env, {
    get(t, key) {
      read(key);
      return Reflect.get(t, key);
    },
    has(t, key) {
      read(key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      read(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    ownKeys(t) {
      check("process.env was listed");
      return Reflect.ownKeys(t);
    },
    // A write is no input: it goes through to the real environment.
    set(t, key, value) {
      return Reflect.set(t, key, value);
    },
    defineProperty(t, key, desc) {
      return Reflect.defineProperty(t, key, desc);
    },
  });
}

/** Opens import `id`'s span: run by the first module its wrapper evaluates. */
export function enterBarrelLoad(id: number): void {
  const barrel = pending.get(id);
  if (barrel === undefined)
    throw new Error(`[barrel-import] no pending barrel import #${id}`);
  if (open)
    throw new Error(
      `[barrel-import] import #${id} (${barrel}) opened its load span inside #${open.id}'s (${open.barrel}): barrel imports must not overlap`,
    );
  open = { id, barrel };
  realEnv = process.env;
  realCwd = process.cwd;
  process.env = guardedEnv(realEnv);
  const cwd = realCwd;
  process.cwd = () => {
    check("process.cwd() was read");
    return cwd();
  };
  installFsCallGuard((op, target) =>
    check(`${op}(${target ?? ""}) was called`),
  );
}

/** Closes import `id`'s span, if it is the open one. */
export function leaveBarrelLoad(id: number): void {
  if (open?.id !== id) return;
  open = null;
  installFsCallGuard(null);
  process.env = realEnv!;
  process.cwd = realCwd!;
  realEnv = null;
  realCwd = null;
}

/**
 * `import(barrelPath)` with its evaluation inside a guarded span. The caller
 * admits one at a time (barrel-import's lane).
 */
export async function guardedImport(
  barrelPath: string,
): Promise<Record<string, unknown>> {
  if (evaluated.has(barrelPath))
    return (await import(barrelPath)) as Record<string, unknown>;
  if (!inputsResolved) {
    barrelLoadInputs();
    inputsResolved = true;
  }
  // Resolved here, as a dynamic `import()` resolves: a static import (the
  // wrapper's) answers from the resolver's cached directory entries, so a
  // barrel written after its folder was first read would not be found.
  const resolved = Bun.resolveSync(barrelPath, dirname(barrelPath));
  const id = ++nextId;
  pending.set(id, resolved);
  try {
    await import(`${NAMESPACE}:wrap:${id}`);
  } finally {
    leaveBarrelLoad(id);
    pending.delete(id);
  }
  evaluated.add(barrelPath);
  // Already evaluated: the module's own namespace, from the ESM cache.
  return (await import(barrelPath)) as Record<string, unknown>;
}

/** The wrapper and span modules, as a Bun plugin's resolve and load hooks. */
export function registerLoadGuard(build: Bun.PluginBuilder): void {
  build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
    path: args.path.slice(NAMESPACE.length + 1),
    namespace: NAMESPACE,
  }));
  build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
    const [kind, idText] = args.path.split(":");
    const id = Number(idText);
    const self = JSON.stringify(SELF);
    if (kind === "wrap") {
      const barrel = pending.get(id);
      if (barrel === undefined)
        throw new Error(`[barrel-import] no pending barrel import #${id}`);
      return {
        contents: [
          `import "${NAMESPACE}:enter:${id}";`,
          `import ${JSON.stringify(barrel)};`,
          `import "${NAMESPACE}:leave:${id}";`,
        ].join("\n"),
        loader: "js",
      };
    }
    if (kind === "enter" || kind === "leave") {
      const fn = kind === "enter" ? "enterBarrelLoad" : "leaveBarrelLoad";
      return {
        contents: `import { ${fn} } from ${self};\n${fn}(${id});`,
        loader: "js",
      };
    }
    throw new Error(`[barrel-import] unknown load-guard module ${args.path}`);
  });
}
