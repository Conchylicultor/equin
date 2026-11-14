import type TS from "typescript";
import {
  isTestCodePath,
  pluginDirOfRepoPath,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  declarationKey,
  literalString,
  siteOf,
  unreadableAt,
  valueReferences,
  type CandidatesFor,
  type Collected,
  type Declaration,
  type ExportRef,
  type ParsedFile,
  type Readout,
  type SourceAnalysis,
  type Unreadable,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";

// The analysis half of no-db-backed-notify: find every externally-served
// resource whose loader reads the DB. Every question is answered through the
// shared source analysis (`checks/plugins/source-analysis`) — which calls serve
// a resource (every alias, barrel and namespace of the serve functions), what
// their options say (inline, a `const`, spreads), which code the call reaches
// (identifiers taken to their declarations across files) and which of it reads
// the DB (uses of `db` itself, never of a name spelled `db`). FAIL-CLOSED: what
// cannot be read is returned as `unreadable`, never skipped.

/**
 * The spellings of a resource with a hand-`notify`, at the barrels they are
 * published from: the old `defineExternalResource(…)` (the substrate the live
 * API compiles onto), and network/live's
 * `serveValue(value, { source: "external", … })` and
 * `serveCollection(c, { source: "external", … })` — a collection answered by
 * hand, whose window / rows / groups answers may be hand SQL — on every host
 * that serves them. Only the external arms have `notify`, so a `source: "db"`
 * value is not a candidate, and neither is an external value that declares its
 * Postgres reads (`reads`): the change feed reaches it through them, and the
 * runtime's drift guard holds its loader to them. Neither is a table-backed
 * `serveCollection` (no `source`): routed, its compiled SQL is reached through
 * its routes; served off the feed (`changes`), every table its compiled SQL
 * reads is declared unfed, which change-feed's boot check holds to the owner's
 * opt-out.
 */
export const NOTIFY_TARGETS = {
  "defineExternalResource@server": {
    rel: "plugins/framework/plugins/server-core/core/index.ts",
    name: "defineExternalResource",
  },
  "defineExternalResource@central": {
    rel: "plugins/framework/plugins/central-core/core/index.ts",
    name: "defineExternalResource",
  },
  "serveValue@server": {
    rel: "plugins/network/plugins/live/server/index.ts",
    name: "serveValue",
  },
  "serveValue@machine": {
    rel: "plugins/network/plugins/live/machine/index.ts",
    name: "serveValue",
  },
  "serveValue@central": {
    rel: "plugins/network/plugins/live/central/index.ts",
    name: "serveValue",
  },
  "serveCollection@server": {
    rel: "plugins/network/plugins/live/server/index.ts",
    name: "serveCollection",
  },
  "serveCollection@machine": {
    rel: "plugins/network/plugins/live/machine/index.ts",
    name: "serveCollection",
  },
} as const satisfies Record<string, ExportRef>;
type NotifyKey = keyof typeof NOTIFY_TARGETS;
export type NotifyMarker = (typeof NOTIFY_TARGETS)[NotifyKey]["name"];

/** The app's DB handle: a read through it is what the check looks for. */
export const DB_TARGET = {
  rel: "plugins/database/server/index.ts",
  name: "db",
} as const satisfies ExportRef;

/**
 * sql-rows' parsed readers: `executeRows(db, …)` / `queryRows(db, …)` read
 * unless their statement is DML. Classified where they are called — their own
 * generic bodies are never walked.
 */
export const READER_TARGETS = {
  executeRows: {
    rel: "plugins/database/plugins/sql-rows/core/index.ts",
    name: "executeRows",
  },
  queryRows: {
    rel: "plugins/database/plugins/sql-rows/core/index.ts",
    name: "queryRows",
  },
} as const satisfies Record<string, ExportRef>;

/** The feed exclusion: `ExcludeFromChangeFeed({ table, reason })`. */
export const EXCLUSION_TARGET = {
  rel: "plugins/network/plugins/live/plugins/change-feed/server/index.ts",
  name: "ExcludeFromChangeFeed",
} as const satisfies ExportRef;

// Legitimate, documented exceptions — resources that read a Postgres schema the
// change-feed DELIBERATELY excludes (only the `public` schema gets triggers) —
// are exempted by the owning plugin's `exempt/index.ts` (rule
// `no-db-backed-notify`), applied by the check, not here. A `public` table a
// plugin opts out of the feed is NOT exempted there: that is derived from the
// plugin's own `ExcludeFromChangeFeed` declarations (see {@link findFeedExclusions}).

/**
 * The tables one plugin opts out of the change feed, in the two spellings a
 * read can name them by: the drizzle table's declaration (keyed as
 * declarations are, so only a reference that RESOLVES to it counts), and the
 * SQL name its `pgTable("…")` declares (`ledger_minute`), which raw SQL
 * (`executeRows(db, { query: sql\`… FROM ledger_minute\` })`) uses instead.
 */
export interface FeedExcludedTables {
  declarations: Set<string>;
  sqlNames: Set<string>;
}

/**
 * The tables each plugin opts out of the change feed: per plugin directory,
 * the table every `ExcludeFromChangeFeed({ table: <identifier>, … })` call in
 * its sources names — taken to its declaration — plus the SQL name that
 * declaration's `pgTable("…")` / `.table("…")` spells. Such a table is
 * feed-blind by the plugin's own reviewed declaration (`reason` is required),
 * so the plugin — the one that owns and writes it — is the only place a change
 * signal for it can come from: it may serve a value over it external and
 * `notify` it from its writer (the latency ledger's minute flush). Derived,
 * never listed: dropping the exclusion drops the exemption with it. A `table:`
 * that is not a plain identifier names nothing and so sanctions nothing (only
 * ever more strict) — name the table literally. Test code never counts: a
 * fixture's exclusion declares nothing the backend runs.
 */
export async function findFeedExclusions(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
): Promise<Map<string, FeedExcludedTables>> {
  const out = new Map<string, FeedExcludedTables>();
  const uses = await analysis.usesOf(
    { exclusion: EXCLUSION_TARGET },
    candidatesFor,
  );
  for (const use of uses.found) {
    if (use.kind !== "call") continue;
    const dir = pluginDirOfRepoPath(use.file.rel);
    if (dir === null || isTestCodePath(use.file.rel.split("/"))) continue;
    const arg = use.call.arguments[0];
    if (arg === undefined) continue;
    const obj = unwrap(ts, arg);
    if (!ts.isObjectLiteralExpression(obj)) continue;
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) || propertyName(ts, p.name) !== "table")
        continue;
      const table = unwrap(ts, p.initializer);
      if (!ts.isIdentifier(table)) continue;
      const b = await analysis.bindingOf(use.file, table);
      if (b.kind !== "read" || b.value.kind !== "declaration") continue;
      const d = b.value.declaration;
      let tables = out.get(dir);
      if (tables === undefined) {
        tables = { declarations: new Set(), sqlNames: new Set() };
        out.set(dir, tables);
      }
      tables.declarations.add(declarationKey(d));
      const sqlName = tableSqlName(ts, analysis, d);
      if (sqlName !== null) tables.sqlNames.add(sqlName);
    }
  }
  return out;
}

/** A table declaration's SQL name: the literal first argument of its `pgTable("…")` / `x.table("…")`. */
function tableSqlName(
  ts: typeof TS,
  analysis: SourceAnalysis,
  d: Declaration,
): string | null {
  const init = analysis.initializerOf(d);
  if (init.kind !== "read") return null;
  const call = unwrap(ts, init.value);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) return null;
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (name !== "pgTable" && name !== "table") return null;
  const sql = literalString(ts, d.file, call.arguments[0]!);
  return sql.kind === "read" ? sql.value : null;
}

export interface DbBackedNotify {
  path: string;
  line: number;
  marker: NotifyMarker;
  /**
   * Where the read is, when it is not inside the call itself: the chain of
   * identifiers followed to reach it, each with its declaration's location.
   */
  via?: string;
}

export interface DbBackedNotifyReport {
  offenders: DbBackedNotify[];
  /** What could not be read where it could change the verdict. */
  unreadable: Unreadable[];
}

/**
 * Every externally-served resource whose loader reads the DB.
 *
 * Each serving call (every use of a {@link NOTIFY_TARGETS} function, through
 * every alias, barrel and namespace) is a candidate when its options say so
 * ({@link servedExternal}). The walk then starts at the call itself and
 * follows, breadth-first and with no depth bound (each declaration is visited
 * once per call, so the walk ends), every value reference a body makes to its
 * declaration — same-file or imported, through barrels and re-exports — and
 * reads each for DB reads ({@link dbReads}): uses of the database's `db`
 * export, or of a name bound to it.
 *
 * Only a READ counts: an external loader may write (`db.insert` / `db.update`
 * / `db.delete`, or an `execute` of DML) — its truth still lives outside
 * Postgres.
 *
 * A reading body is excused when it, or the call, names a table the serving
 * call's plugin excludes from the feed ({@link findFeedExclusions}) — by a
 * reference resolving to its declaration, or by its SQL name in a literal —
 * per body and per table, so the same plugin serving an external value over
 * only feed-visible tables is still flagged.
 *
 * FAIL-CLOSED: a serve function used other than called, options or a source
 * that cannot be read (a parameter of a wrapper, a computed value), and code
 * the walk cannot follow (an import of no repo file, a namespace used whole, a
 * value reaching the call through a parameter of an enclosing function) are
 * returned in `unreadable`.
 */
export async function scanDbBackedNotify(
  ts: typeof TS,
  analysis: SourceAnalysis,
  candidatesFor: CandidatesFor,
  feedExclusions: ReadonlyMap<string, FeedExcludedTables>,
  opts: {
    /** Files no violation is reported in (test code, exemptions). */
    skips: (rel: string) => boolean;
    /** Yields the check thread between bodies. */
    slice: () => Promise<void>;
  },
): Promise<DbBackedNotifyReport> {
  const unreadable: Unreadable[] = [];
  const offenders: DbBackedNotify[] = [];
  const [uses, handleKey, readerKeys] = await Promise.all([
    analysis.usesOf(NOTIFY_TARGETS, candidatesFor),
    declarationKeyOf(analysis, DB_TARGET),
    Promise.all(
      Object.values(READER_TARGETS).map((r) => declarationKeyOf(analysis, r)),
    ).then((keys) => new Set(keys)),
  ]);
  for (const u of uses.unreadable)
    if (!opts.skips(u.site.rel)) unreadable.push(u);
  // The serve functions themselves are the substrate, never part of a
  // loader: their callee reference, and another resource a loader names (a
  // `follows` target — its own serve call is checked where it is made), stop
  // the walk.
  const serveKeys = new Set(
    await Promise.all(
      Object.values(NOTIFY_TARGETS).map((r) => declarationKeyOf(analysis, r)),
    ),
  );
  const walker = createWalker(ts, analysis, {
    handleKey,
    readerKeys,
    serveKeys,
    candidatesFor,
    slice: opts.slice,
  });
  for (const use of uses.found) {
    if (use.kind === "reexport" || use.kind === "reexport-all") continue;
    if (opts.skips(use.file.rel)) continue;
    if (use.kind === "member-call") {
      unreadable.push(
        unreadableAt(
          use.file,
          use.call,
          `\`${use.exported}.${use.member}(…)\` — call ${use.exported} directly, so its options can be read.`,
        ),
      );
      continue;
    }
    const marker = NOTIFY_TARGETS[use.key].name;
    if (marker !== "defineExternalResource") {
      const external = await servedExternal(ts, analysis, use.file, use.call);
      if (external.kind === "unreadable") {
        unreadable.push(external.unreadable);
        continue;
      }
      if (!external.value) continue;
    }
    const dir = pluginDirOfRepoPath(use.file.rel);
    const excluded = dir === null ? undefined : feedExclusions.get(dir);
    // The loader code: a serve call's options (its first argument is the
    // declaration it serves — the contract, not code that runs); every
    // argument of the old spelling.
    const roots =
      marker === "defineExternalResource"
        ? use.call.arguments
        : use.call.arguments.slice(1);
    const found = await walker.findRead(use.file, roots, excluded);
    unreadable.push(...found.unreadable);
    if (found.chain === null) continue;
    const line = siteOf(use.file, use.call).line;
    offenders.push(
      found.chain.length === 0
        ? { path: use.file.rel, line, marker }
        : { path: use.file.rel, line, marker, via: found.chain.join(" → ") },
    );
  }
  const byText = new Map(
    unreadable.map((u) => [`${u.site.rel}:${u.site.line}:${u.reason}`, u]),
  );
  return { offenders, unreadable: [...byText.values()] };
}

async function declarationKeyOf(
  analysis: SourceAnalysis,
  ref: ExportRef,
): Promise<string> {
  const b = await analysis.exportedBinding(ref.rel, ref.name);
  if (b.kind !== "read" || b.value.kind !== "declaration")
    throw new Error(
      `no-db-backed-notify: ${ref.rel} export \`${ref.name}\` is not a declaration in the repo`,
    );
  return declarationKey(b.value.declaration);
}

/** What the options of a serve call say. */
interface ServeOptions {
  /** The options' own `source`, when they spell one. */
  source: string | undefined;
  /**
   * Whether they declare `reads` (static or a thunk) — `undefined` when they
   * spell no `reads` key, so a spread's key and a later own key override in
   * source order, as at runtime.
   */
  reads: boolean | undefined;
}

/**
 * Is this `serveValue(value, { … })` / `serveCollection(c, { … })` call the
 * external arm, declaring no reads (a collection has no `reads` to declare)?
 * Its second argument's OWN `source` (an object literal inside the loader
 * never answers) is the literal `"external"`, and it has no own `reads` key (a
 * declared read routes the value from the change feed, and the runtime's drift
 * guard holds the loader to it). The options are read inline, through a
 * `const`, and through spreads; a `source` through a shorthand or a `const` is
 * followed to its literal. Anything else — options passed in through a
 * parameter (a wrapper), a computed `source` — is Unreadable.
 */
async function servedExternal(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  call: TS.CallExpression,
): Promise<Readout<boolean>> {
  const arg = call.arguments[1];
  if (arg === undefined || call.arguments.length !== 2)
    return cannot(
      file,
      call,
      "a serve call with other than (declaration, options) arguments cannot be read.",
    );
  const opts = await readOptions(ts, analysis, file, arg, new Set());
  if (opts.kind === "unreadable") return opts;
  return {
    kind: "read",
    value: opts.value.source === "external" && !opts.value.reads,
  };
}

async function readOptions(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  expr: TS.Expression,
  seen: Set<string>,
): Promise<Readout<ServeOptions>> {
  const e = unwrap(ts, expr);
  if (ts.isIdentifier(e)) {
    const value = await constValue(ts, analysis, file, e, seen);
    if (value.kind === "unreadable") return value;
    return readOptions(ts, analysis, value.value.file, value.value.expr, seen);
  }
  if (ts.isCallExpression(e)) {
    const returned = await returnedValue(ts, analysis, file, e);
    if (returned.kind === "unreadable") return returned;
    return readOptions(
      ts,
      analysis,
      returned.value.file,
      returned.value.expr,
      seen,
    );
  }
  if (!ts.isObjectLiteralExpression(e))
    return cannot(
      file,
      expr,
      "serve options that are not an object literal (or a `const` or a helper returning one) cannot be read — pass them inline.",
    );
  let out: ServeOptions = { source: undefined, reads: undefined };
  for (const p of e.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = await readOptions(ts, analysis, file, p.expression, seen);
      if (inner.kind === "unreadable") return inner;
      out = {
        source: inner.value.source ?? out.source,
        reads: inner.value.reads ?? out.reads,
      };
      continue;
    }
    const name = p.name === undefined ? null : propertyName(ts, p.name);
    if (name === null)
      return cannot(
        file,
        p,
        "a computed key in serve options cannot be read — spell the key.",
      );
    if (name === "reads") {
      const value = ts.isPropertyAssignment(p)
        ? p.initializer
        : ts.isShorthandPropertyAssignment(p)
          ? p.name
          : null;
      if (value === null)
        return cannot(file, p, "a `reads` that is not a value cannot be read.");
      // Its own trail: a const the options also read elsewhere (`source`, a
      // spread) is not a cycle.
      const declared = await readsDeclared(
        ts,
        analysis,
        file,
        value,
        new Set(seen),
      );
      if (declared.kind === "unreadable") return declared;
      out = { ...out, reads: declared.value };
      continue;
    }
    if (name !== "source") continue;
    const value = ts.isPropertyAssignment(p)
      ? p.initializer
      : ts.isShorthandPropertyAssignment(p)
        ? p.name
        : null;
    if (value === null)
      return cannot(file, p, "a `source` that is not a value cannot be read.");
    const source = await stringValue(ts, analysis, file, value, seen);
    if (source.kind === "unreadable") return source;
    out = { ...out, source: source.value };
  }
  return { kind: "read", value: out };
}

/**
 * Does a `reads` value declare reads? Fail-closed: only a value seen to be
 * one — an object or array literal, a thunk, or a `const` / one-return helper
 * holding one — declares them; `undefined`, `null` and `void …` declare none
 * (the runtime reads them as no `reads` at all), a ternary declares them only
 * when both arms do, and anything else cannot be read.
 */
async function readsDeclared(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  expr: TS.Expression,
  seen: Set<string>,
): Promise<Readout<boolean>> {
  const e = unwrap(ts, expr);
  if (
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e)
  )
    return { kind: "read", value: true };
  if (
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(e) ||
    (ts.isIdentifier(e) && e.text === "undefined")
  )
    return { kind: "read", value: false };
  if (ts.isConditionalExpression(e)) {
    const whenTrue = await readsDeclared(ts, analysis, file, e.whenTrue, seen);
    if (whenTrue.kind === "unreadable") return whenTrue;
    const whenFalse = await readsDeclared(
      ts,
      analysis,
      file,
      e.whenFalse,
      seen,
    );
    if (whenFalse.kind === "unreadable") return whenFalse;
    return { kind: "read", value: whenTrue.value && whenFalse.value };
  }
  const resolved = ts.isIdentifier(e)
    ? await constValue(ts, analysis, file, e, seen)
    : ts.isCallExpression(e)
      ? await returnedValue(ts, analysis, file, e)
      : cannot<{ file: ParsedFile; expr: TS.Expression }>(
          file,
          expr,
          "a `reads` that is not a literal, a thunk, a `const` or a helper's one return cannot be read — spell it inline.",
        );
  if (resolved.kind === "unreadable") return resolved;
  return readsDeclared(
    ts,
    analysis,
    resolved.value.file,
    resolved.value.expr,
    seen,
  );
}

/** A string literal, directly or through `const`s. */
async function stringValue(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  expr: TS.Expression,
  seen: Set<string>,
): Promise<Readout<string>> {
  const e = unwrap(ts, expr);
  if (ts.isIdentifier(e)) {
    const value = await constValue(ts, analysis, file, e, seen);
    if (value.kind === "unreadable") return value;
    return stringValue(ts, analysis, value.value.file, value.value.expr, seen);
  }
  return literalString(ts, file, expr);
}

/** The initializer of the `const` a name is bound to — or why it cannot be read. */
async function constValue(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  id: TS.Identifier,
  seen: Set<string>,
): Promise<Readout<{ file: ParsedFile; expr: TS.Expression }>> {
  const b = await analysis.bindingOf(file, id);
  if (b.kind === "unreadable") return b;
  if (b.value.kind !== "declaration")
    return cannot(
      file,
      id,
      `\`${id.text}\` is not a \`const\` of the repo, so its value cannot be read.`,
    );
  const d = b.value.declaration;
  if (ts.isParameter(d.node))
    return cannot(
      file,
      id,
      `\`${id.text}\` is a parameter — the serve call is inside a wrapper, whose callers decide what it serves; call the serve function directly with its options.`,
    );
  const key = declarationKey(d);
  if (seen.has(key))
    return cannot(file, id, `\`${id.text}\` refers back to itself.`);
  seen.add(key);
  const init = analysis.initializerOf(d);
  if (init.kind === "unreadable") return init;
  return { kind: "read", value: { file: d.file, expr: init.value } };
}

/**
 * What a call to a repo helper returns, when the helper spells it once: an
 * arrow's expression body, or a block's single `return` (`catalogOptions(…)`
 * building a serve call's options).
 */
async function returnedValue(
  ts: typeof TS,
  analysis: SourceAnalysis,
  file: ParsedFile,
  call: TS.CallExpression,
): Promise<Readout<{ file: ParsedFile; expr: TS.Expression }>> {
  const fail = cannot<{ file: ParsedFile; expr: TS.Expression }>(
    file,
    call,
    "serve options built by a call are read only from a repo helper with one `return` of them — pass them inline.",
  );
  const callee = unwrap(ts, call.expression);
  if (!ts.isIdentifier(callee)) return fail;
  const b = await analysis.bindingOf(file, callee);
  if (b.kind === "unreadable") return b;
  if (b.value.kind !== "declaration") return fail;
  const d = b.value.declaration;
  let fn: TS.Node = d.node;
  if (ts.isVariableDeclaration(fn) && fn.initializer !== undefined)
    fn = unwrap(ts, fn.initializer);
  if (
    !(
      ts.isFunctionDeclaration(fn) ||
      ts.isArrowFunction(fn) ||
      ts.isFunctionExpression(fn)
    ) ||
    fn.body === undefined
  )
    return fail;
  if (!ts.isBlock(fn.body))
    return { kind: "read", value: { file: d.file, expr: fn.body } };
  const returns: TS.ReturnStatement[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  const only = returns.length === 1 ? returns[0]!.expression : undefined;
  if (only === undefined) return fail;
  return { kind: "read", value: { file: d.file, expr: only } };
}

/** A body the walk reads: one subtree of one file. */
interface Body {
  file: ParsedFile;
  root: TS.Node;
}

/** What one body says: whether it reads the DB, the declarations it references, what could not be read. */
interface BodyFacts {
  reads: boolean;
  refs: { label: string; declaration: Declaration }[];
  /** Parameters of a function around the body (a wrapper's), whose callers' arguments are followed. */
  params: { label: string; file: ParsedFile; param: TS.ParameterDeclaration }[];
  /** Excluded-table declarations it references, and every string it spells. */
  tableRefs: Set<string>;
  literals: string[];
  unreadable: Unreadable[];
}

function createWalker(
  ts: typeof TS,
  analysis: SourceAnalysis,
  {
    handleKey,
    readerKeys,
    serveKeys,
    candidatesFor,
    slice,
  }: {
    candidatesFor: CandidatesFor;
    handleKey: string;
    readerKeys: ReadonlySet<string>;
    serveKeys: ReadonlySet<string>;
    slice: () => Promise<void>;
  },
) {
  /** Is a declaration a serve function, or a resource one serves (`const x = serveValue(…)`)? */
  const isServe = async (d: Declaration): Promise<boolean> => {
    if (serveKeys.has(declarationKey(d))) return true;
    if (!ts.isVariableDeclaration(d.node) || d.node.initializer === undefined)
      return false;
    const init = unwrap(ts, d.node.initializer);
    if (!ts.isCallExpression(init)) return false;
    const callee = unwrap(ts, init.expression);
    if (!ts.isIdentifier(callee)) return false;
    const b = await analysis.bindingOf(d.file, callee);
    return (
      b.kind === "read" &&
      b.value.kind === "declaration" &&
      serveKeys.has(declarationKey(b.value.declaration))
    );
  };

  const facts = new Map<string, Promise<BodyFacts>>();
  const handles = new Map<string, Promise<boolean>>();

  const bodyKey = (b: Body) => `${b.file.rel}:${b.root.pos}:${b.root.end}`;

  /** Is a declaration the DB handle, or a name bound to it? */
  const isHandle = (d: Declaration): Promise<boolean> => {
    const key = declarationKey(d);
    if (key === handleKey) return Promise.resolve(true);
    let hit = handles.get(key);
    if (hit === undefined) {
      handles.set(key, Promise.resolve(false)); // a cycle binds nothing
      hit = handleAlias(d);
      handles.set(key, hit);
    }
    return hit;
  };

  /**
   * A name bound to the handle: `const tx = db`, a parameter defaulting to it
   * (`conn: Db = db`), or a transaction callback's parameter
   * (`db.transaction(async (tx) => …)`).
   */
  const handleAlias = async (d: Declaration): Promise<boolean> => {
    const n = d.node;
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n)) &&
      n.initializer !== undefined
    ) {
      const init = unwrap(ts, n.initializer);
      if (ts.isIdentifier(init)) {
        const b = await analysis.bindingOf(d.file, init);
        if (b.kind === "read" && b.value.kind === "declaration")
          return isHandle(b.value.declaration);
      }
    }
    if (ts.isParameter(n)) {
      const fn = n.parent;
      let arg: TS.Node = fn;
      while (ts.isParenthesizedExpression(arg.parent)) arg = arg.parent;
      const call = arg.parent;
      if (
        ts.isCallExpression(call) &&
        call.arguments[0] === arg &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "transaction"
      ) {
        const recv = unwrap(ts, call.expression.expression);
        if (ts.isIdentifier(recv)) {
          const b = await analysis.bindingOf(d.file, recv);
          if (b.kind === "read" && b.value.kind === "declaration")
            return isHandle(b.value.declaration);
        }
      }
    }
    return false;
  };

  /**
   * Is the use of the handle at `id` a read? Writes are `h.insert` /
   * `h.update` / `h.delete`, an `h.execute(…)` of DML, and a binding of
   * another name to it (whose own uses are classified). Anything else — a
   * select, a transaction, the handle passed to a function — reads.
   */
  const handleUseReads = async (
    file: ParsedFile,
    id: TS.Identifier,
  ): Promise<boolean> => {
    let outer: TS.Node = id;
    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent)
    )
      outer = outer.parent;
    const p = outer.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === outer) {
      const op = p.name.text;
      if (op === "insert" || op === "update" || op === "delete") return false;
      if (op === "execute" && ts.isCallExpression(p.parent))
        return !executesDml(ts, p.parent);
      return true;
    }
    if (
      (ts.isVariableDeclaration(p) || ts.isParameter(p)) &&
      p.initializer === outer
    )
      return false;
    if (ts.isCallExpression(p) && p.arguments[0] === outer) {
      const callee = unwrap(ts, p.expression);
      if (ts.isIdentifier(callee)) {
        const b = await analysis.bindingOf(file, callee);
        if (
          b.kind === "read" &&
          b.value.kind === "declaration" &&
          readerKeys.has(declarationKey(b.value.declaration))
        )
          return !executesDml(ts, p);
      }
    }
    return true;
  };

  const readFacts = async (body: Body): Promise<BodyFacts> => {
    await slice();
    const out: BodyFacts = {
      reads: false,
      refs: [],
      params: [],
      tableRefs: new Set(),
      literals: [],
      unreadable: [],
    };
    const seen = new Set<string>();
    const inBody = (d: Declaration) =>
      d.file.rel === body.file.rel &&
      d.node.pos >= body.root.pos &&
      d.node.end <= body.root.end;
    for (const id of valueReferences(ts, body.root)) {
      let b = await analysis.bindingOf(body.file, id);
      if (b.kind === "unreadable") {
        out.unreadable.push(b.unreadable);
        continue;
      }
      let label = id.text;
      if (b.value.kind === "namespace") {
        const p = id.parent;
        if (!(ts.isPropertyAccessExpression(p) && p.expression === id)) {
          out.unreadable.push(
            unreadableAt(
              body.file,
              id,
              `the namespace \`${id.text}\` is used whole, so which of its exports the loader reaches cannot be read; access them by name.`,
            ),
          );
          continue;
        }
        b = await analysis.exportedBinding(b.value.rel, p.name.text);
        if (b.kind === "unreadable") {
          out.unreadable.push(b.unreadable);
          continue;
        }
        label = `${id.text}.${p.name.text}`;
      }
      if (b.value.kind === "namespace") {
        out.unreadable.push(
          unreadableAt(
            body.file,
            id,
            `\`${label}\` is a nested namespace, so which of its exports the loader reaches cannot be read; import them by name.`,
          ),
        );
        continue;
      }
      if (b.value.kind !== "declaration") continue; // npm, a global
      const d = b.value.declaration;
      const key = declarationKey(d);
      out.tableRefs.add(key);
      if (await isHandle(d)) {
        if (!out.reads && (await handleUseReads(body.file, id)))
          out.reads = true;
        continue;
      }
      if (readerKeys.has(key)) continue;
      if (inBody(d)) continue;
      if (await isServe(d)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ts.isParameter(d.node) || ts.isBindingElement(d.node)) {
        // A parameter of a function around the body — a wrapper of the serve
        // call: what it holds is each caller's argument.
        const decl = declarationRoot(ts, d.node);
        if (ts.isParameter(decl)) {
          out.params.push({ label, file: d.file, param: decl });
          continue;
        }
      }
      out.refs.push({ label, declaration: d });
    }
    const visit = (n: TS.Node): void => {
      if (ts.isStringLiteralLike(n)) out.literals.push(n.text);
      else if (ts.isTemplateExpression(n)) {
        out.literals.push(n.head.text);
        for (const span of n.templateSpans)
          out.literals.push(span.literal.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(body.root);
    return out;
  };

  const factsOf = (body: Body): Promise<BodyFacts> => {
    const key = bodyKey(body);
    let hit = facts.get(key);
    if (hit === undefined) {
      hit = readFacts(body);
      facts.set(key, hit);
    }
    return hit;
  };

  /** Does a body name a table its serving plugin excludes from the feed? */
  const excused = (
    f: BodyFacts,
    excluded: FeedExcludedTables | undefined,
  ): boolean => {
    if (excluded === undefined) return false;
    for (const k of excluded.declarations) if (f.tableRefs.has(k)) return true;
    for (const name of excluded.sqlNames) {
      const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`);
      if (f.literals.some((l) => re.test(l))) return true;
    }
    return false;
  };

  /**
   * Breadth-first from the call's loader code (`roots`): the reference chain
   * (empty when the call's own arguments read) to the first body that reads the DB and is not
   * excused, or null when nothing it reaches does — and what could not be
   * read on the way.
   */
  const findRead = async (
    file: ParsedFile,
    roots: readonly TS.Node[],
    excluded: FeedExcludedTables | undefined,
  ): Promise<{ chain: string[] | null; unreadable: Unreadable[] }> => {
    const unreadable: Unreadable[] = [];
    let callExcused = false;
    for (const root of roots)
      if (excused(await factsOf({ file, root }), excluded)) callExcused = true;
    const seen = new Set<string>(roots.map((root) => bodyKey({ file, root })));
    let frontier: Array<{ body: Body; chain: string[] }> = roots.map(
      (root) => ({ body: { file, root }, chain: [] }),
    );
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const { body, chain } of frontier) {
        const f = await factsOf(body);
        unreadable.push(...f.unreadable);
        if (f.reads && !callExcused && !excused(f, excluded))
          return { chain, unreadable };
        for (const { label, file: pf, param } of f.params) {
          const args = await callerArguments(pf, param);
          unreadable.push(...args.unreadable);
          for (const arg of args.found) {
            const key = bodyKey(arg.body);
            if (seen.has(key)) continue;
            seen.add(key);
            next.push({
              body: arg.body,
              chain: [
                ...chain,
                `${label} ← ${arg.body.file.rel}:${siteOf(arg.body.file, arg.body.root).line}`,
              ],
            });
          }
        }
        for (const { label, declaration: d } of f.refs) {
          const root = walkRoot(ts, d.node);
          if (root === null) continue;
          const target = { file: d.file, root };
          const key = bodyKey(target);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({
            body: target,
            chain: [...chain, `${label} (${d.site.rel}:${d.site.line})`],
          });
        }
      }
      frontier = next;
    }
    return { chain: null, unreadable };
  };

  const callers = new Map<
    string,
    Promise<Collected<{ call: TS.CallExpression; file: ParsedFile }>>
  >();

  /** Every call of a wrapper, through every alias and barrel — memoized per function. */
  const callsOf = (
    file: ParsedFile,
    fn: TS.SignatureDeclaration,
  ): Promise<Collected<{ call: TS.CallExpression; file: ParsedFile }>> => {
    const key = `${file.rel}:${fn.pos}`;
    let hit = callers.get(key);
    if (hit === undefined) {
      hit = readCallers(file, fn);
      callers.set(key, hit);
    }
    return hit;
  };

  const readCallers = async (
    file: ParsedFile,
    fn: TS.SignatureDeclaration,
  ): Promise<Collected<{ call: TS.CallExpression; file: ParsedFile }>> => {
    const named = helperName(ts, fn);
    const exported =
      named === null
        ? null
        : await analysis.exportedBinding(file.rel, named.name);
    if (
      named === null ||
      exported === null ||
      exported.kind !== "read" ||
      exported.value.kind !== "declaration" ||
      exported.value.declaration.file.rel !== file.rel ||
      exported.value.declaration.node !== named.node
    )
      return {
        found: [],
        unreadable: [
          unreadableAt(
            file,
            fn,
            "the serve call takes code from a parameter of a function that is not an exported, named helper — export it so its callers can be read, or call the serve function directly.",
          ),
        ],
      };
    const uses = await analysis.usesOf(
      { helper: { rel: file.rel, name: named.name } },
      candidatesFor,
    );
    const out: Collected<{ call: TS.CallExpression; file: ParsedFile }> = {
      found: [],
      unreadable: uses.unreadable.filter(
        (u) => !isTestCodePath(u.site.rel.split("/")),
      ),
    };
    for (const use of uses.found) {
      if (isTestCodePath(use.file.rel.split("/"))) continue;
      if (use.kind === "call")
        out.found.push({ call: use.call, file: use.file });
      else if (use.kind === "member-call")
        out.unreadable.push(
          unreadableAt(
            use.file,
            use.call,
            `\`${use.exported}.${use.member}(…)\` — call the wrapper directly, so its arguments can be read.`,
          ),
        );
    }
    return out;
  };

  /** What each caller of the wrapper passes for `param`. */
  const callerArguments = async (
    file: ParsedFile,
    param: TS.ParameterDeclaration,
  ): Promise<Collected<{ body: Body }>> => {
    const fn = param.parent;
    const index = fn.parameters.indexOf(param);
    if (param.dotDotDotToken !== undefined)
      return {
        found: [],
        unreadable: [
          unreadableAt(
            file,
            param,
            "a rest parameter of a wrapper cannot be followed to its arguments — name each one.",
          ),
        ],
      };
    const calls = await callsOf(file, fn);
    const out: Collected<{ body: Body }> = {
      found: [],
      unreadable: [...calls.unreadable],
    };
    for (const { call, file: cf } of calls.found) {
      const spread = call.arguments
        .slice(0, index + 1)
        .find((a) => ts.isSpreadElement(a));
      if (spread !== undefined) {
        out.unreadable.push(
          unreadableAt(
            cf,
            spread,
            "a spread argument to a wrapper of a serve call cannot be followed — pass each argument.",
          ),
        );
        continue;
      }
      // An omitted argument is the parameter's default.
      const arg = call.arguments[index];
      if (arg !== undefined) out.found.push({ body: { file: cf, root: arg } });
      else if (param.initializer !== undefined)
        out.found.push({ body: { file, root: param.initializer } });
    }
    return out;
  };

  return { findRead };
}

/** A function's name and the declaration node its module exports it by: `function f`, or `const f = (…) => …`. */
function helperName(
  ts: typeof TS,
  fn: TS.SignatureDeclaration,
): { name: string; node: TS.Node } | null {
  if (ts.isFunctionDeclaration(fn))
    return fn.name === undefined ? null : { name: fn.name.text, node: fn };
  let n: TS.Node = fn;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(p) &&
    p.initializer === n &&
    ts.isIdentifier(p.name)
  )
    return { name: p.name.text, node: p };
  return null;
}

/** The node a declaration's code lives in: a variable's whole declaration, a function, a class. */
function walkRoot(ts: typeof TS, node: TS.Node): TS.Node | null {
  if (ts.isEnumDeclaration(node)) return null;
  return declarationRoot(ts, node);
}

/** Up from a destructured name to the declaration holding its pattern. */
function declarationRoot(ts: typeof TS, node: TS.Node): TS.Node {
  let n = node;
  while (
    ts.isBindingElement(n) ||
    ts.isObjectBindingPattern(n) ||
    ts.isArrayBindingPattern(n)
  )
    n = n.parent;
  return n;
}

/** SQL statements that write: an `execute` of one is not a read. */
const DML_WRITE = /^(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * Is this call running DML — EVERY outermost `sql\`…\`` template among its
 * arguments (one per branch of a conditional statement) starting INSERT /
 * UPDATE / DELETE / MERGE? A statement built elsewhere (no template), a
 * `WITH`, or any branch that selects is not: it counts as a read.
 */
function executesDml(ts: typeof TS, call: TS.CallExpression): boolean {
  const templates: TS.TaggedTemplateExpression[] = [];
  const visit = (n: TS.Node): void => {
    if (
      ts.isTaggedTemplateExpression(n) &&
      ts.isIdentifier(n.tag) &&
      n.tag.text === "sql"
    ) {
      templates.push(n); // its `${sql\`…\`}` fragments are not statements
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const a of call.arguments) visit(a);
  return (
    templates.length > 0 &&
    templates.every((tpl) => {
      const t = tpl.template;
      const head = ts.isNoSubstitutionTemplateLiteral(t) ? t.text : t.head.text;
      return DML_WRITE.test(head.replace(/^[\s(]+/, ""));
    })
  );
}

/** Expression wrappers that do not change the value. */
function unwrap(ts: typeof TS, e: TS.Expression): TS.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}

function propertyName(ts: typeof TS, name: TS.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  )
    return name.text;
  return null;
}

function cannot<T>(
  file: ParsedFile,
  node: TS.Node,
  reason: string,
): Readout<T> {
  return { kind: "unreadable", unreadable: unreadableAt(file, node, reason) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
