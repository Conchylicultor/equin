import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { TIMED_FS_CALLS } from "../core";

const createRule = lintRuleCreator(import.meta.url);

/** Where the timed calls are imported from. */
export const TIMED_FS_MODULE = "@plugins/packages/plugins/timed-fs/core";

const SYNC_MODULES = new Set(["fs", "node:fs"]);
const PROMISES_MODULES = new Set(["fs/promises", "node:fs/promises"]);
const SYNC_NAMES: ReadonlySet<string> = new Set(
  Object.keys(TIMED_FS_CALLS.sync),
);
const PROMISE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(TIMED_FS_CALLS.promises),
);

/** Browser code has no disk: out of scope. */
const BROWSER_FOLDER = /\/(web|exhibits)\//;

type Ctx = Readonly<TSESLint.RuleContext<"untimed", []>>;

function propertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier")
    return node.property.name;
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  )
    return node.property.value;
  return null;
}

/** A module-local binding of `node:fs` (`sync`) or of its promises API. */
interface FsBinding {
  variable: TSESLint.Scope.Variable;
  api: "sync" | "promises";
  decl: TSESTree.ImportDeclaration;
}

/** One call to move: `fs.statSync` → `statSync`, `fs.promises.stat` → `stat`. */
interface MemberUse {
  node: TSESTree.MemberExpression;
  name: string;
  binding: FsBinding;
}

/**
 * no-untimed-fs-read
 *
 * A file read, listing or stat is made through `packages/timed-fs`, which
 * keeps node's name and type and hands every call past its floor on as a
 * named wait (`fs-read` / `fs-readdir` / `fs-stat`) — so a stalled disk names
 * itself in the profiler, the slow-op reports and the `fs-wait` log instead of
 * reading as the caller's own work (2026-11-03: a 12 s glob in a live read, a
 * 10.8 s boot gap, a 127 s `readdirSync` in a check — each needed a manual
 * investigation). Reported, with a fix that moves the import:
 *
 * - a named import of a timed call from `node:fs` (the `*Sync` ones,
 *   `existsSync`) or `node:fs/promises`;
 * - a timed call through a namespace or default import of either, or
 *   through `fs.promises` (`fs.statSync(…)`, `fsp.readdir(…)`,
 *   `fs.promises.readFile(…)`).
 *
 * Not covered: the callback forms, writes, `require("fs")`, a `promises`
 * object passed around as a value. Glob scans are `no-untimed-glob-scan`'s.
 */
export default createRule({
  name: "no-untimed-fs-read",
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "File reads, listings and stats go through packages/timed-fs (same names and types as node:fs), so a call stalled on the disk is recorded as a named wait instead of the caller's own work.",
    },
    schema: [],
    messages: {
      untimed: `\`{{name}}\` from node:fs is untimed: a disk stall inside it reads as the caller's own work, and nobody can tell from the record that the filesystem was the cause. Import it from "${TIMED_FS_MODULE}" (same name, same type; the fix moves it), which records a slow call as a named \`fs-*\` wait.`,
    },
  },
  defaultOptions: [],
  create(context) {
    if (BROWSER_FOLDER.test(context.filename)) return {};
    const source = context.sourceCode;
    const imports: TSESTree.ImportDeclaration[] = [];
    return {
      ImportDeclaration(node) {
        imports.push(node);
      },
      "Program:exit"() {
        run(context, source, imports);
      },
    };
  },
});

function run(
  context: Ctx,
  source: TSESLint.SourceCode,
  imports: readonly TSESTree.ImportDeclaration[],
): void {
  const named: {
    decl: TSESTree.ImportDeclaration;
    spec: TSESTree.ImportSpecifier;
  }[] = [];
  const bindings: FsBinding[] = [];
  let timedDecl: TSESTree.ImportDeclaration | undefined;

  for (const decl of imports) {
    const from = decl.source.value;
    if (from === TIMED_FS_MODULE && decl.importKind !== "type")
      timedDecl = decl;
    const sync = SYNC_MODULES.has(from);
    const promises = PROMISES_MODULES.has(from);
    if ((!sync && !promises) || decl.importKind === "type") continue;
    for (const spec of decl.specifiers) {
      if (spec.type === "ImportSpecifier") {
        if (spec.importKind === "type") continue;
        const imported =
          spec.imported.type === "Identifier"
            ? spec.imported.name
            : spec.imported.value;
        if ((sync ? SYNC_NAMES : PROMISE_NAMES).has(imported))
          named.push({ decl, spec });
        else if (sync && imported === "promises")
          bindings.push(bindingOf(source, spec, "promises", decl));
      } else {
        // `import * as fs` / `import fs` — its members are the calls.
        bindings.push(
          bindingOf(source, spec, sync ? "sync" : "promises", decl),
        );
      }
    }
  }

  const uses: MemberUse[] = [];
  for (const b of bindings) {
    for (const ref of b.variable.references) {
      const id = ref.identifier;
      const parent = id.parent;
      if (parent?.type !== "MemberExpression" || parent.object !== id) continue;
      const name = propertyName(parent);
      if (name === null) continue;
      if (b.api === "sync" && name === "promises") {
        const outer = parent.parent;
        if (outer?.type !== "MemberExpression" || outer.object !== parent)
          continue;
        const inner = propertyName(outer);
        if (inner !== null && PROMISE_NAMES.has(inner))
          uses.push({ node: outer, name: inner, binding: b });
        continue;
      }
      if ((b.api === "sync" ? SYNC_NAMES : PROMISE_NAMES).has(name))
        uses.push({ node: parent, name, binding: b });
    }
  }

  if (named.length === 0 && uses.length === 0) return;

  const fix = buildFix(source, named, uses, bindings, timedDecl);
  const reports: { node: TSESTree.Node; name: string }[] = [
    ...named.map(({ spec }) => ({
      node: spec as TSESTree.Node,
      name: spec.local.name,
    })),
    ...uses.map((u) => ({
      node: u.node as TSESTree.Node,
      name: source.getText(u.node),
    })),
  ];
  // One fix for the file, on the first report: every edit of the file's fs
  // imports must land together, or two fs imports would each mint an import
  // of the timed module.
  reports.forEach((r, i) =>
    context.report({
      node: r.node,
      messageId: "untimed",
      data: { name: r.name },
      ...(i === 0 && fix !== null ? { fix } : {}),
    }),
  );
}

function bindingOf(
  source: TSESLint.SourceCode,
  spec: TSESTree.ImportClause,
  api: "sync" | "promises",
  decl: TSESTree.ImportDeclaration,
): FsBinding {
  const variable = source.getDeclaredVariables(spec)[0]!;
  return { variable, api, decl };
}

/** Is `name` free at `node` (no binding reaches it from its scope up)? */
function isFree(
  source: TSESLint.SourceCode,
  node: TSESTree.Node,
  name: string,
): boolean {
  for (
    let s: TSESLint.Scope.Scope | null = source.getScope(node);
    s;
    s = s.upper
  )
    if (s.set.has(name)) return false;
  return true;
}

function specText(imported: string, local: string): string {
  return imported === local ? imported : `${imported} as ${local}`;
}

function buildFix(
  source: TSESLint.SourceCode,
  named: readonly {
    decl: TSESTree.ImportDeclaration;
    spec: TSESTree.ImportSpecifier;
  }[],
  uses: readonly MemberUse[],
  bindings: readonly FsBinding[],
  timedDecl: TSESTree.ImportDeclaration | undefined,
): TSESLint.ReportFixFunction | null {
  // What the timed import must bind: imported name → local name.
  const want = new Map<string, string>();
  for (const { spec } of named) {
    const imported =
      spec.imported.type === "Identifier"
        ? spec.imported.name
        : spec.imported.value;
    want.set(
      `${imported}\0${spec.local.name}`,
      specText(imported, spec.local.name),
    );
  }
  const replaced = new Map<TSESTree.MemberExpression, string>();
  for (const u of uses) {
    // The bare name, when nothing else answers to it where the call is (a
    // moved named import of the same call does); else `timed<Name>`.
    const movedSame = [...want.keys()].some(
      (k) => k === `${u.name}\0${u.name}`,
    );
    let local = u.name;
    if (!movedSame && !isFree(source, u.node, local)) {
      local = `timed${u.name[0]!.toUpperCase()}${u.name.slice(1)}`;
      if (!isFree(source, u.node, local)) return null;
    }
    replaced.set(u.node, local);
    want.set(`${u.name}\0${local}`, specText(u.name, local));
  }
  if (timedDecl) {
    for (const s of timedDecl.specifiers)
      if (s.type === "ImportSpecifier") {
        const imported =
          s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
        want.delete(`${imported}\0${s.local.name}`);
      }
  }

  // Each fs import declaration: what stays on node:fs.
  const moved = new Set(named.map((n) => n.spec));
  const declsTouched = new Set<TSESTree.ImportDeclaration>(
    named.map((n) => n.decl),
  );
  // A namespace / default import whose every use moved is dropped.
  const dropped = new Set<TSESTree.ImportClause>();
  for (const b of bindings) {
    const refs = b.variable.references;
    const movedRefs = uses.filter((u) => u.binding === b).length;
    if (refs.length > 0 && movedRefs === refs.length) {
      const spec = b.variable.defs[0]?.node as
        TSESTree.ImportClause | undefined;
      if (spec) {
        dropped.add(spec);
        declsTouched.add(b.decl);
      }
    }
  }

  const newSpecs = [...want.values()];
  const timedImport =
    newSpecs.length === 0
      ? ""
      : `import { ${newSpecs.join(", ")} } from "${TIMED_FS_MODULE}";`;

  return (fixer) => {
    const edits: TSESLint.RuleFix[] = [];
    for (const [node, local] of replaced)
      edits.push(fixer.replaceText(node, local));
    let placed = timedImport === "" || timedDecl !== undefined;
    if (timedDecl && timedImport !== "") {
      const kept = timedDecl.specifiers.map((s) => source.getText(s));
      edits.push(
        fixer.replaceText(
          timedDecl,
          `import { ${[...kept, ...newSpecs].join(", ")} } from "${TIMED_FS_MODULE}";`,
        ),
      );
    }
    const touched = [...declsTouched].sort((a, b) => a.range[0] - b.range[0]);
    for (const decl of touched) {
      const rest = decl.specifiers.filter(
        (s) =>
          !(s.type === "ImportSpecifier" && moved.has(s)) && !dropped.has(s),
      );
      const text = rest.length === 0 ? "" : importText(source, decl, rest);
      const withTimed = placed
        ? text
        : text === ""
          ? timedImport
          : `${text}\n${timedImport}`;
      placed = true;
      edits.push(fixer.replaceText(decl, withTimed));
    }
    if (!placed) {
      const anchor = bindings[0]?.decl ?? named[0]!.decl;
      edits.push(fixer.insertTextAfter(anchor, `\n${timedImport}`));
    }
    return edits;
  };
}

function importText(
  source: TSESLint.SourceCode,
  decl: TSESTree.ImportDeclaration,
  rest: readonly TSESTree.ImportClause[],
): string {
  const head = rest
    .filter((s) => s.type !== "ImportSpecifier")
    .map((s) => source.getText(s));
  const specs = rest
    .filter((s) => s.type === "ImportSpecifier")
    .map((s) => source.getText(s));
  const parts = [...head];
  if (specs.length > 0) parts.push(`{ ${specs.join(", ")} }`);
  return `import ${parts.join(", ")} from ${source.getText(decl.source)};`;
}
