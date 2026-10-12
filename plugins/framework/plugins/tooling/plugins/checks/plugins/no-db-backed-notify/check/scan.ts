import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import {
  lineAt,
  markerCallSpans,
  matchBracket,
  parseStringField,
  type MarkerCallSpan,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { Definition, ModuleIndex } from "./resolve";

// The pure half of no-db-backed-notify: find every externally-served resource
// whose loader reads the DB. No git, no fs — the check feeds it candidate
// sources from listCandidateSources and a ModuleIndex over `ctx.repo()` to
// follow loaders into other files — so which calls count, and what the
// exemption covers, are unit-testable on literal strings.

/**
 * The two spellings of a resource with a hand-`notify`: the old
 * `defineExternalResource(…)`, and network/live's
 * `serveValue(value, { source: "external", … })`. Only serveValue's external
 * arm has `notify`, so a `source: "db"` call is not a candidate.
 */
export const NOTIFY_MARKERS = ["defineExternalResource", "serveValue"] as const;
export type NotifyMarker = (typeof NOTIFY_MARKERS)[number];

// Legitimate, documented exceptions — resources that read a Postgres schema the
// change-feed DELIBERATELY excludes (only the `public` schema gets triggers) —
// are exempted by the owning plugin's `exempt/index.ts` (rule
// `no-db-backed-notify`), applied by the check, not here. A `public` table a
// plugin opts out of the feed is NOT exempted there: that is derived from the
// plugin's own `ExcludeFromChangeFeed` declarations (see {@link findFeedExclusions}).

/** The marker of a feed exclusion: `ExcludeFromChangeFeed({ table, reason })`. */
export const FEED_EXCLUSION_MARKER = "ExcludeFromChangeFeed";

/**
 * The plugin a repo-relative file belongs to: the longest
 * `plugins/<name>(/plugins/<name>)*` prefix of its path
 * (`plugins/debug/plugins/latency-ledger/server/internal/x.ts` →
 * `plugins/debug/plugins/latency-ledger`). Null for a file outside `plugins/`.
 */
export function pluginRootOf(rel: string): string | null {
  const segments = rel.split("/");
  let end = 0;
  // A `plugins/<name>` pair whose name is a directory (not the file itself).
  while (segments[end] === "plugins" && end + 2 < segments.length) end += 2;
  return end === 0 ? null : segments.slice(0, end).join("/");
}

/**
 * The tables one plugin opts out of the change feed, in the two spellings a
 * read can name them by: the drizzle table identifier (`_ledgerMinute`), and
 * the SQL name its `pgTable("…")` declares (`ledger_minute`), which raw SQL
 * (`executeRows(db, { query: sql\`… FROM ledger_minute\` })`) uses instead.
 */
export interface FeedExcludedTables {
  identifiers: Set<string>;
  sqlNames: Set<string>;
}

/**
 * The tables each plugin opts out of the change feed: per plugin root, the
 * identifier every `ExcludeFromChangeFeed({ table: <identifier>, … })` call in
 * its (masked) sources names, plus the SQL name of the table that identifier
 * is declared as (resolved through `modules`). Such a table is feed-blind by
 * the plugin's own reviewed declaration (`reason` is required), so the plugin —
 * the one that owns and writes it — is the only place a change signal for it
 * can come from: it may serve a value over it external and `notify` it from
 * its writer (the latency ledger's minute flush). Derived, never listed:
 * dropping the exclusion drops the exemption with it. A `table:` that is not a
 * plain identifier (shorthand, a member access, a call) names nothing and so
 * sanctions nothing — name the table literally. Test code never counts: a
 * fixture's exclusion declares nothing the backend runs.
 */
export async function findFeedExclusions(
  sources: ReadonlyArray<{ rel: string; src: string }>,
  modules: ModuleIndex,
): Promise<Map<string, FeedExcludedTables>> {
  const out = new Map<string, FeedExcludedTables>();
  for (const { rel, src } of sources) {
    const root = pluginRootOf(rel);
    if (root === null || isTestCodePath(rel.split("/"))) continue;
    const module = modules.seed(rel, src);
    for (const span of markerCallSpans(module.masked, FEED_EXCLUSION_MARKER)) {
      const table = parseStringField(
        src.slice(span.open + 1, span.close),
        "table",
      );
      if (table.kind !== "dynamic" || !IDENTIFIER.test(table.expr)) continue;
      let tables = out.get(root);
      if (!tables) {
        tables = { identifiers: new Set(), sqlNames: new Set() };
        out.set(root, tables);
      }
      tables.identifiers.add(table.expr);
      const def = await modules.resolve(module, table.expr);
      const sqlName = def && TABLE_SQL_NAME.exec(definitionText(def, "src"));
      if (sqlName) tables.sqlNames.add(sqlName[1]!);
    }
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A table declaration's SQL name: `pgTable("name"` / `.table("name"`. */
const TABLE_SQL_NAME =
  /(?:\bpgTable|\.table)\s*(?:<[^>]*>)?\s*\(\s*["'`]([\w.]+)["'`]/;

export interface DbBackedNotify {
  path: string;
  line: number;
  marker: NotifyMarker;
  /**
   * Where the read is, when it is not inside the call itself: the chain of
   * identifiers followed to reach it, each with its definition's location.
   */
  via?: string;
}

/**
 * Every externally-served resource in `sources` whose loader reads the DB.
 *
 * The scan starts at each call's own argument span and follows, breadth-first
 * and with no depth bound (each definition is visited once per call, so the
 * walk ends), every identifier a body references as a function (called,
 * passed as an argument, given as a property value, or the receiver of a
 * method call — `memo.get(id)` follows `memo`'s const) to its definition — a
 * same-file function or const, or an imported one (`modules` resolves
 * relative and `@plugins/…` specifiers through barrels and re-exports). A
 * fixed depth missed the loader → helper → lookup → query chains that are
 * common in the repo. Each body is read MASKED, so `db` inside a string or comment
 * never counts, and scoping to the call and what it reaches (not the file)
 * keeps unrelated `db` use elsewhere in a file out.
 *
 * Only a READ counts ({@link dbReads}): an external loader may write
 * (`db.insert` / `db.update` / `db.delete`, or an `execute` of DML) — its
 * truth still lives outside Postgres.
 *
 * A reading body is excused when it, or the call, names a table the serving
 * call's plugin excludes from the feed ({@link findFeedExclusions}) — by its
 * identifier or its SQL name — per body and per table, so the same plugin
 * serving an external value over only feed-visible tables is still flagged.
 * (A body naming an excluded table AND a feed-visible one passes: the scan
 * reads text and cannot tell which reads the loader makes.)
 */
export async function scanDbBackedNotify(
  sources: ReadonlyArray<{ rel: string; src: string }>,
  feedExclusions: ReadonlyMap<string, FeedExcludedTables>,
  modules: ModuleIndex,
): Promise<DbBackedNotify[]> {
  const out: DbBackedNotify[] = [];
  // The unbounded walk regex-scans many bodies; yield every ~10 ms so the check
  // never holds the runner's shared thread (checks/CLAUDE.md).
  const slice = createTimeSlicer();
  for (const { rel, src } of sources) {
    const root = pluginRootOf(rel);
    const excluded = root === null ? undefined : feedExclusions.get(root);
    const module = modules.seed(rel, src);
    for (const marker of NOTIFY_MARKERS) {
      for (const span of markerCallSpans(module.masked, marker)) {
        if (
          marker === "serveValue" &&
          !servesExternal(src, module.masked, span)
        ) {
          continue;
        }
        const call: Definition = {
          name: marker,
          module,
          start: span.open,
          end: span.close + 1,
        };
        const callExcused = excused(call, excluded);
        const found = await findRead(
          call,
          modules,
          (body) => callExcused || excused(body, excluded),
          slice,
        );
        if (found === null) continue;
        const line = lineAt(module.masked, span.identifier);
        out.push(
          found.length === 0
            ? { path: rel, line, marker }
            : { path: rel, line, marker, via: found.join(" → ") },
        );
      }
    }
  }
  return out;
}

/**
 * Breadth-first from `call`: the reference chain (empty when the call's own
 * span reads) to the first body that reads the DB and is not `isExcused`, or
 * null when nothing it reaches does.
 */
async function findRead(
  call: Definition,
  modules: ModuleIndex,
  isExcused: (body: Definition) => boolean,
  slice: () => Promise<void>,
): Promise<string[] | null> {
  const seen = new Set<string>([bodyKey(call)]);
  let frontier: Array<{ body: Definition; chain: string[] }> = [
    { body: call, chain: [] },
  ];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { body, chain } of frontier) {
      await slice();
      if (dbReads(body).length > 0 && !isExcused(body)) return chain;
      for (const ref of referencedIdentifiers(body)) {
        const def = await modules.resolve(body.module, ref);
        if (!def || seen.has(bodyKey(def))) continue;
        seen.add(bodyKey(def));
        const at = `${def.module.rel}:${lineAt(def.module.masked, def.start)}`;
        next.push({ body: def, chain: [...chain, `${ref} (${at})`] });
      }
    }
    frontier = next;
  }
  return null;
}

const bodyKey = (d: Definition) => `${d.module.rel}:${d.start}`;

function definitionText(def: Definition, which: "src" | "masked"): string {
  return def.module[which].slice(def.start, def.end);
}

/** Does `body` name a table its serving plugin excludes from the feed? */
function excused(
  body: Definition,
  excluded: FeedExcludedTables | undefined,
): boolean {
  if (!excluded) return false;
  return (
    namesAny(definitionText(body, "masked"), excluded.identifiers) ||
    namesAny(definitionText(body, "src"), excluded.sqlNames)
  );
}

/**
 * Never followed: words that look like a call (`if (`) but reference nothing,
 * the DB handle itself, and sql-rows' readers — a reader call is classified
 * where it is made ({@link dbReads}), so walking into the reader's own generic
 * body would only re-find that read without the caller's table names.
 */
const NOT_FOLLOWED = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "await",
  "new",
  "super",
  "import",
  "require",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "yield",
  "do",
  "else",
  "case",
  "throw",
  "async",
  "db",
  "executeRows",
  "queryRows",
]);

/**
 * The identifiers `body` references as a function: called (`load(` /
 * `load<T>(`), passed as an argument (`(load,` / `, load)`), or given as a
 * property value (`loader: load,`), or the receiver of a method call (`memo`
 * in `memo.get(id)`: the scan cannot tell which method runs, so it follows
 * the receiver's whole definition — a same-file or imported const such as a
 * `createSignedMemo(…)` binding, whose initializer holds the loader). A local
 * or a global receiver resolves to nothing and is not followed.
 */
function referencedIdentifiers(body: Definition): Set<string> {
  const text = definitionText(body, "masked");
  const out = new Set<string>();
  const patterns = [
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g,
    /[(,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/g,
    /:\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g,
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\??\.\s*[A-Za-z_$][\w$]*\s*(?:<[^<>()]*>)?\s*\(/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const id = m[1]!;
      if (!NOT_FOLLOWED.has(id) && id !== body.name) out.add(id);
    }
  }
  return out;
}

/** SQL statements that write: an `execute` of one is not a read. */
const DML_WRITE = /^(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * Offsets of the DB reads in `body`. The DB handle is reached as a `db.`
 * member access (`db.select` / `db.query` / `db.execute` / `db.$count` / …)
 * or handed to sql-rows' parsed readers (`executeRows(db, …)` /
 * `queryRows(db, …)`). Writes are not reads: `db.insert` / `db.update` /
 * `db.delete`, and an `execute` / `executeRows` / `queryRows` whose first
 * `sql\`…\`` statement is DML. Anything the scan cannot classify — a
 * transaction, an `execute` of a query built elsewhere, a `WITH` — counts as a
 * read.
 */
export function dbReads(body: Definition): number[] {
  const { masked, src } = body.module;
  const text = masked.slice(body.start, body.end);
  const out: number[] = [];
  const handles = ["db", ...dbAliases(text)].map((h) =>
    h.replace(/\$/g, "\\$"),
  );
  const member = new RegExp(
    `(?<![\\w$.])(?:${handles.join("|")})\\s*\\.\\s*([\\w$]+)`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = member.exec(text))) {
    const at = body.start + m.index;
    const op = m[1]!;
    if (op === "insert" || op === "update" || op === "delete") continue;
    if (op === "execute" && executesDml(masked, src, at + m[0].length)) {
      continue;
    }
    out.push(at);
  }
  const reader = new RegExp(
    `(?<![\\w$.])(?:executeRows|queryRows)\\s*\\(\\s*(?:${handles.join("|")})(?![\\w$])`,
    "g",
  );
  while ((m = reader.exec(text))) {
    const at = body.start + m.index;
    if (executesDml(masked, src, masked.indexOf("(", at))) continue;
    out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Names `text` binds to the DB handle, so a read through them is a read:
 * a parameter default (`conn = db`, `conn: Db = db`), a local (`const tx =
 * db`), and a transaction callback's parameter (`db.transaction(async (tx) =>`
 * — the `db.transaction` itself already counts, this covers a `tx` read the
 * callback makes when it is the followed body).
 */
function dbAliases(text: string): string[] {
  const out = new Set<string>();
  const bound =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[^=,;(){}]+?)?\s*=\s*db(?![\w$.])/g;
  let m: RegExpExecArray | null;
  while ((m = bound.exec(text))) {
    if (m[1] !== "db") out.add(m[1]!);
  }
  const tx =
    /\bdb\s*\.\s*transaction\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = tx.exec(text))) out.add(m[1]!);
  return [...out];
}

/**
 * Is the call whose `(` is at (or after) `from` running DML — its first
 * `sql\`…\`` template's statement starting INSERT / UPDATE / DELETE / MERGE?
 */
function executesDml(masked: string, src: string, from: number): boolean {
  const open = masked.indexOf("(", from);
  if (open < 0) return false;
  const close = matchBracket(masked, open, "(", ")");
  if (close < 0) return false;
  const tpl = /\bsql\s*`/.exec(masked.slice(open, close));
  if (!tpl) return false;
  const body = src.slice(open + tpl.index + tpl[0].length, close);
  return DML_WRITE.test(body.replace(/^[\s(]+/, ""));
}

/**
 * Is this `serveValue(value, { … })` call the external arm? Its second argument
 * must be an inline options object whose OWN `source:` (depth 0 of that object,
 * so an object literal inside the loader never answers) is the literal
 * `"external"`. Anything else — the db arm, or a call whose options are not an
 * inline object, like `serveValue`'s own declaration `(value: …, opts: …)` —
 * is not a candidate. A computed `source: expr` is not read either: the
 * resources facet already throws on one, so it never gets past a build. A
 * `source` the facet cannot see — shorthand `{ source }`, one inside a spread,
 * or options passed as a variable — is not read here either (a false negative,
 * like a loader passed by reference, whose `db.` sits outside the call).
 */
function servesExternal(
  src: string,
  masked: string,
  span: MarkerCallSpan,
): boolean {
  const comma = firstTopLevelComma(masked, span.open + 1, span.close);
  if (comma < 0) return false;
  let open = comma + 1;
  while (open < span.close && /\s/.test(masked[open]!)) open++;
  if (masked[open] !== "{") return false;
  const close = matchBracket(masked, open, "{", "}");
  if (close < 0 || close > span.close) return false;
  const source = parseStringField(src.slice(open + 1, close), "source", {
    depth0: true,
  });
  return source.kind === "value" && source.value === "external";
}

/** Does masked `text` name any of `identifiers` as a whole word? */
function namesAny(text: string, identifiers: ReadonlySet<string>): boolean {
  for (const id of identifiers) {
    const escaped = id.replace(/\$/g, "\\$");
    if (new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text)) return true;
  }
  return false;
}

/** Index of the first `,` at bracket depth 0 in `masked[from, to)`, or -1. */
function firstTopLevelComma(masked: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) return i;
  }
  return -1;
}
