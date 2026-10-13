import type TS from "typescript";

// The pure half of `change-feed:producer-writes` (A11 of
// research/2026-10-01-global-scoped-change-routing-p5-p8.md): every write to a
// produced table goes through its producer's `mutate`. A table with a change
// producer has no trigger, so a write that bypasses the producer reaches no live
// reader — the surface showing that row stays stale until it remounts, with
// nothing to say so. No git, no fs: the check feeds it sources, so what counts
// as a declaration, a binding and a write is unit-testable on literal strings.
//
// Three passes:
//  1. the producers: `const <producer> = defineChangeProducer({ table:
//     <binding>, … })` — the binding (an identifier) names the produced table,
//     the producer variable is whose `.mutate` may write it;
//  2. each binding's SQL name: the `pgTable("<name>", …)` or
//     `defineEntity("<name>", …)` its declaration calls (through any wrapper,
//     e.g. `deriveUpdatedAt(pgTable(…))`), or — for an entity's table bound
//     apart (`const _t = entity.table`) — the one its entity's declaration in
//     the same file calls;
//  3. the writes: a drizzle `.insert(<t>)` / `.update(<t>)` / `.delete(<t>)`
//     whose `<t>` is a produced binding IN THAT FILE'S SCOPE — declared there,
//     imported (under any alias), re-bound (`const t = _reports`), or reached
//     as a property (`schema._reports`) — that is not the builder a producer's
//     `.mutate(…)` callback returns; and a SQL string or template — raw text or
//     a `sql` template interpolating the binding — that INSERTs into, UPDATEs,
//     DELETEs FROM, TRUNCATEs or MERGEs INTO a produced table.
//
// Names, not symbols: resolving through the type checker would need the whole
// program for one check. Scoping each identifier to what its file declares or
// imports is what keeps a same-named local (`seen.delete(_reports)` with an
// unrelated `_reports`) from being flagged, and an alias from being missed.

export interface Source {
  rel: string;
  src: string;
}

/** One `defineChangeProducer` call and the table binding it names. */
export interface ProducerDecl {
  binding: string;
  /** The variable the producer is assigned to, when it is (`const p = defineChangeProducer(…)`). */
  producer: string | null;
  path: string;
  line: number;
}

/** A write to a produced table outside its producer. */
export interface ProducedWrite {
  path: string;
  line: number;
  /** `drizzle` — a query-builder write; `sql` — a raw SQL write. */
  kind: "drizzle" | "sql";
  table: string;
  text: string;
}

function parse(ts: typeof TS, { rel, src }: Source): TS.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
}

function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walk(node: TS.Node, ts: typeof TS, visit: (n: TS.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, ts, visit));
}

function calleeName(ts: typeof TS, call: TS.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Pass 1: every `defineChangeProducer({ table: <identifier> })`. */
export function findProducerDecls(
  ts: typeof TS,
  sources: readonly Source[],
): ProducerDecl[] {
  const out: ProducerDecl[] = [];
  for (const source of sources) {
    const sf = parse(ts, source);
    walk(sf, ts, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (calleeName(ts, node) !== "defineChangeProducer") return;
      const spec = node.arguments[0];
      if (!spec || !ts.isObjectLiteralExpression(spec)) return;
      for (const prop of spec.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "table" &&
          ts.isIdentifier(prop.initializer)
        ) {
          const parent = node.parent;
          out.push({
            binding: prop.initializer.text,
            producer:
              ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
                ? parent.name.text
                : null,
            path: source.rel,
            line: lineOf(sf, node),
          });
        }
      }
    });
  }
  return out;
}

/** The callees whose first string argument is a table's SQL name. */
const TABLE_DECLARERS = new Set(["pgTable", "defineEntity"]);

// The SQL table names `expr` declares: the first string argument of each
// `pgTable(…)` / `defineEntity(…)` call within it (through any wrapper), or —
// when it is `<entity>.table` — those of `<entity>`'s own initializer in
// `decls` (one hop: an entity is declared by its `defineEntity` call).
function declaredTableNames(
  ts: typeof TS,
  expr: TS.Expression,
  decls: ReadonlyMap<string, TS.Expression>,
): string[] {
  const names: string[] = [];
  walk(expr, ts, (inner) => {
    if (!ts.isCallExpression(inner)) return;
    const callee = calleeName(ts, inner);
    if (callee === null || !TABLE_DECLARERS.has(callee)) return;
    const first = inner.arguments[0];
    if (
      first &&
      (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
    ) {
      names.push(first.text);
    }
  });
  if (
    names.length === 0 &&
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "table" &&
    ts.isIdentifier(expr.expression)
  ) {
    const entity = decls.get(expr.expression.text);
    if (entity && !ts.isPropertyAccessExpression(entity)) {
      return declaredTableNames(ts, entity, decls);
    }
  }
  return names;
}

// Every `const <name> = <initializer>` in a file, by name.
function fileDecls(
  ts: typeof TS,
  sf: TS.SourceFile,
): Map<string, TS.Expression> {
  const decls = new Map<string, TS.Expression>();
  walk(sf, ts, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      decls.set(node.name.text, node.initializer);
    }
  });
  return decls;
}

/**
 * Pass 2: each binding's SQL table name — what a `const <binding> = …`
 * initializer declares (`pgTable("<name>", …)` / `defineEntity("<name>", …)`,
 * through any wrapper, or `<entity>.table` resolved through its entity's
 * declaration in the same file). A binding declared in several files maps to
 * every name found.
 */
export function resolveTableNames(
  ts: typeof TS,
  sources: readonly Source[],
  bindings: ReadonlySet<string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const source of sources) {
    const sf = parse(ts, source);
    const decls = fileDecls(ts, sf);
    for (const [binding, initializer] of decls) {
      if (!bindings.has(binding)) continue;
      for (const name of declaredTableNames(ts, initializer, decls)) {
        const names = out.get(binding) ?? new Set<string>();
        names.add(name);
        out.set(binding, names);
      }
    }
  }
  return out;
}

const WRITE_VERBS = new Set(["insert", "update", "delete"]);
// A raw SQL write's verb, right before the table it names.
const SQL_VERB = String.raw`(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?(?:\s+only)?|merge\s+into)`;
// The verb as the tail of a template chunk, with the table interpolated next.
const SQL_VERB_TAIL = new RegExp(String.raw`\b${SQL_VERB}\s*$`, "i");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether `expr` contains a call to `callee` (through any wrapper).
function callsWithin(ts: typeof TS, expr: TS.Node, callee: string): boolean {
  let found = false;
  walk(expr, ts, (n) => {
    if (!found && ts.isCallExpression(n) && calleeName(ts, n) === callee) {
      found = true;
    }
  });
  return found;
}

/**
 * The names a file's scope gives to members of `originals`: each original it
 * declares itself (a `const <original> = …` whose initializer `declares`, so an
 * unrelated local that only shares the name is not one), each it imports
 * (`import { a as b }` maps `b` → `a`), and each local re-bound to one
 * (`const b = a`). Local → original.
 */
function scopeNames(
  ts: typeof TS,
  sf: TS.SourceFile,
  originals: ReadonlySet<string>,
  declares: (initializer: TS.Expression) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  const rebinds: Array<[string, string]> = [];
  walk(sf, ts, (node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (originals.has(imported)) out.set(node.name.text, imported);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (originals.has(node.name.text)) {
        if (node.initializer && declares(node.initializer)) {
          out.set(node.name.text, node.name.text);
        }
      } else if (node.initializer && ts.isIdentifier(node.initializer)) {
        rebinds.push([node.name.text, node.initializer.text]);
      }
    }
  });
  // A re-bind of a re-bind resolves too (bounded: each pass adds one hop).
  for (let changed = true; changed;) {
    changed = false;
    for (const [local, from] of rebinds) {
      const original = out.get(from);
      if (original !== undefined && !out.has(local)) {
        out.set(local, original);
        changed = true;
      }
    }
  }
  return out;
}

// The produced binding an expression names in this file's scope: an identifier
// the scope maps, or a property access whose name is a produced binding
// (`schema._reports`, a namespace import). Null otherwise.
function producedBindingOf(
  ts: typeof TS,
  expr: TS.Expression,
  inScope: ReadonlyMap<string, string>,
  originals: ReadonlySet<string>,
): string | null {
  if (ts.isIdentifier(expr)) return inScope.get(expr.text) ?? null;
  if (ts.isPropertyAccessExpression(expr) && originals.has(expr.name.text)) {
    return expr.name.text;
  }
  return null;
}

// Whether `node` is (part of) the builder a producer's `.mutate(…)` callback
// RETURNS — the expression body of an arrow, or a `return` in a function body
// — where the callee's receiver is a producer in this file's scope. A side
// write elsewhere in the callback, or under any other `.mutate`, is not one.
function isMutateBuilder(
  ts: typeof TS,
  node: TS.Node,
  producers: ReadonlyMap<string, string>,
): boolean {
  let returned = false;
  for (let n: TS.Node = node; n.parent; n = n.parent) {
    const parent = n.parent;
    if (ts.isReturnStatement(parent)) returned = true;
    // An arrow's EXPRESSION body is its return value (a block body is not).
    if (ts.isArrowFunction(parent) && parent.body === n && !ts.isBlock(n)) {
      returned = true;
    }
    if (!(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))) {
      continue;
    }
    // The innermost enclosing function decides.
    const call = parent.parent;
    return (
      returned &&
      ts.isCallExpression(call) &&
      call.arguments.includes(parent) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "mutate" &&
      ts.isIdentifier(call.expression.expression) &&
      producers.has(call.expression.expression.text)
    );
  }
  return false;
}

/**
 * Pass 3: the writes to a produced table outside its producer. `tables` maps
 * each binding to its SQL names (pass 2); `producers` are the producer
 * variables (pass 1) whose `.mutate` builders may write them.
 */
export function findProducedWrites(
  ts: typeof TS,
  sources: readonly Source[],
  tables: ReadonlyMap<string, ReadonlySet<string>>,
  producers: ReadonlySet<string>,
): ProducedWrite[] {
  const bindings = new Set(tables.keys());
  const names = [...new Set([...tables.values()].flatMap((s) => [...s]))];
  const rawWrite = names.map((name) => ({
    name,
    re: new RegExp(
      String.raw`\b${SQL_VERB}\s+(?:"?public"?\s*\.\s*)?"?${escapeRegExp(name)}"?(?![\w$"])`,
      "i",
    ),
  }));
  const tableOf = (binding: string): string =>
    [...(tables.get(binding) ?? [])].sort().join(" | ");
  const out: ProducedWrite[] = [];
  for (const source of sources) {
    const sf = parse(ts, source);
    const decls = fileDecls(ts, sf);
    const inScope = scopeNames(
      ts,
      sf,
      bindings,
      (init) => declaredTableNames(ts, init, decls).length > 0,
    );
    const producersInScope = scopeNames(ts, sf, producers, (init) =>
      callsWithin(ts, init, "defineChangeProducer"),
    );
    const lines = source.src.split("\n");
    const push = (
      node: TS.Node,
      kind: ProducedWrite["kind"],
      table: string,
    ) => {
      const line = lineOf(sf, node);
      out.push({
        path: source.rel,
        line,
        kind,
        table,
        text: (lines[line - 1] ?? "").trim(),
      });
    };
    walk(sf, ts, (node) => {
      // A drizzle write on a produced table's binding, outside a builder.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        WRITE_VERBS.has(node.expression.name.text)
      ) {
        const arg = node.arguments[0];
        const binding = arg && producedBindingOf(ts, arg, inScope, bindings);
        if (binding && !isMutateBuilder(ts, node, producersInScope)) {
          push(node, "drizzle", tableOf(binding));
        }
        return;
      }
      // A raw SQL write naming a produced table.
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        const hit = rawWrite.find((w) => w.re.test(node.text));
        if (hit) push(node, "sql", hit.name);
        return;
      }
      if (ts.isTemplateExpression(node)) {
        // The literal text, every interpolation a placeholder…
        const text =
          node.head.text +
          node.templateSpans.map((s) => "${}" + s.literal.text).join("");
        const hit = rawWrite.find((w) => w.re.test(text));
        if (hit) {
          push(node, "sql", hit.name);
          return;
        }
        // …and a `sql` template interpolating the table object itself.
        let before = node.head.text;
        for (const span of node.templateSpans) {
          const binding = producedBindingOf(
            ts,
            span.expression,
            inScope,
            bindings,
          );
          if (binding && SQL_VERB_TAIL.test(before)) {
            push(node, "sql", tableOf(binding));
            return;
          }
          before = span.literal.text;
        }
      }
    });
  }
  return out;
}
