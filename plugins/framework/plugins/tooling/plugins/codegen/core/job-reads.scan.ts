import {
  failClosed,
  fileTargetUses,
  literalString,
  siteOf,
  unreadableAt,
  type ParsedFile,
  type Unreadable,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import { resolveSpecifier } from "@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";

// The job-reads generator's per-file scan (`list-catalog-gen.ts`): the
// contributed lists each supervised job's `run` body reads whole, read from
// its `read(List)` calls. A scan's records are keyed by its module's whole
// closure (`FileScan.url`), so this module holds the scan and the code it runs,
// and nothing else.

const MARKER = "defineSupervisedJob";

/** The modules `defineSupervisedJob` can be imported from, by repo path. */
const JOB_MODULES = [
  "plugins/infra/plugins/jobs/plugins/supervised-job/server/index.ts",
  "plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/define-supervised-job.ts",
] as const;

const isJobFile = (path: string): boolean =>
  JOB_MODULES.some((m) => path === m || path.endsWith(`/${m}`));

const PREFILTER_RE = /\bdefineSupervisedJob\b/;

const HINT =
  "A supervised job's child starts the contributors of exactly the lists its `run` body reads with " +
  "`read(List)` — the build reads those calls, so each must be one it can read: `read` called directly " +
  "in the body (never passed on), with a list imported by name from its plugin's barrel. (job-reads scan)";

/** One `read(List)` of a job's body: the list, by the import that names it. */
export interface ScannedRead {
  /** The import specifier, as written (`@plugins/x/server`). */
  readonly specifier: string;
  /** The name the barrel exports it under. */
  readonly exported: string;
  /** `file:line`, for an error naming the call. */
  readonly site: string;
}

/** One `defineSupervisedJob({ name, run })` of a file, with what its body reads. */
export interface ScannedJob {
  readonly job: string;
  readonly reads: readonly ScannedRead[];
}

/** Every import binding of the file: local name → where it comes from. */
function importsOf(sf: ts.SourceFile): {
  named: Map<string, { specifier: string; exported: string }>;
  namespaces: Map<string, string>;
} {
  const named = new Map<string, { specifier: string; exported: string }>();
  const namespaces = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined)
      named.set(clause.name.text, { specifier, exported: "default" });
    const b = clause.namedBindings;
    if (b === undefined) continue;
    if (ts.isNamespaceImport(b)) {
      namespaces.set(b.name.text, specifier);
      continue;
    }
    for (const el of b.elements) {
      if (el.isTypeOnly) continue;
      named.set(el.name.text, {
        specifier,
        exported: (el.propertyName ?? el.name).text,
      });
    }
  }
  return { named, namespaces };
}

/** The `run` function of a job's spec object, or why it cannot be read; `null` for none (an `argv` / `steps` job). */
function runFunctionOf(
  file: ParsedFile,
  spec: ts.ObjectLiteralExpression,
): ts.FunctionLikeDeclaration | Unreadable | null {
  for (const p of spec.properties) {
    const name =
      p.name !== undefined &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        ? p.name.text
        : undefined;
    if (ts.isSpreadAssignment(p))
      return unreadableAt(
        file,
        p,
        "the job's spec is spread: whether it has a `run` body cannot be read; write the spec inline.",
      );
    if (name !== "run") continue;
    if (ts.isMethodDeclaration(p)) return p;
    if (ts.isPropertyAssignment(p)) {
      let init = p.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        return init;
      return unreadableAt(
        file,
        p,
        "`run` is not written inline: the lists it reads cannot be read; write the body inline (`async run(input, { read }) { … }`).",
      );
    }
    return unreadableAt(
      file,
      p,
      "`run` is not written inline: the lists it reads cannot be read; write the body inline.",
    );
  }
  return null;
}

/**
 * The `read(List)` calls of one `run` body. Its context parameter is either
 * destructured (`{ log, read }`, `read` possibly renamed) or one name whose
 * every use is a member access (`ctx.read(List)`, `ctx.log(…)`). Anything else
 * — the context or `read` passed on, `read` called with anything but a list
 * named by an import — is Unreadable: a read the scan could not see would be a
 * list the child does not start, so it refuses instead.
 */
function readsOf(
  file: ParsedFile,
  run: ts.FunctionLikeDeclaration,
  imports: ReturnType<typeof importsOf>,
  unreadable: Unreadable[],
): ScannedRead[] {
  const ctxParam = run.parameters[1];
  if (ctxParam === undefined || run.body === undefined) return [];
  /** Is this node a use of `read`? */
  let isRead: (node: ts.Node) => boolean;
  /** Is this identifier a use of the binding we follow (the context, or `read`)? */
  let followed: string;
  const pattern = ctxParam.name;
  if (ts.isObjectBindingPattern(pattern)) {
    let local: string | undefined;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken !== undefined) {
        unreadable.push(
          unreadableAt(
            file,
            el,
            "the context's rest is collected: `read` could leave the body inside it; destructure what you use by name.",
          ),
        );
        return [];
      }
      const prop = el.propertyName ?? el.name;
      if (!ts.isIdentifier(prop) || prop.text !== "read") continue;
      if (!ts.isIdentifier(el.name)) {
        unreadable.push(
          unreadableAt(
            file,
            el,
            "`read` is destructured into a pattern; bind it to a name.",
          ),
        );
        return [];
      }
      local = el.name.text;
    }
    if (local === undefined) return [];
    followed = local;
    isRead = (node) => ts.isIdentifier(node) && node.text === local;
  } else if (ts.isIdentifier(pattern)) {
    const ctx = pattern.text;
    followed = ctx;
    isRead = (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === ctx &&
      node.name.text === "read";
  } else {
    unreadable.push(
      unreadableAt(
        file,
        ctxParam,
        "the context parameter is not a name or an object pattern.",
      ),
    );
    return [];
  }

  const out: ScannedRead[] = [];
  const visit = (node: ts.Node): void => {
    // A second binding of the followed name inside the body shadows it.
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === followed
    ) {
      unreadable.push(
        unreadableAt(
          file,
          node,
          `\`${followed}\` is declared again in the body, shadowing the context's; rename it.`,
        ),
      );
      return;
    }
    if (ts.isIdentifier(node) && node.text === followed) {
      const p = node.parent;
      // The name as a member (`x.read`) or a key is not this binding.
      const notAReference =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node);
      if (!notAReference) {
        const use: ts.Node = isRead(node) ? node : isRead(p) ? p : node;
        if (use === node && !isRead(node)) {
          // `ctx.<other>` is fine; anything else lets the context escape.
          if (!(ts.isPropertyAccessExpression(p) && p.expression === node)) {
            unreadable.push(
              unreadableAt(
                file,
                p,
                `\`${followed}\` is used as a value: \`read\` could be called where the scan cannot see; use its members by name.`,
              ),
            );
          }
        } else {
          const call = use.parent;
          if (!(ts.isCallExpression(call) && call.expression === use)) {
            unreadable.push(
              unreadableAt(
                file,
                call,
                "`read` is used other than called — passed on, it reads a list the scan cannot see; call it in the body.",
              ),
            );
          } else if (call.arguments.length !== 1) {
            unreadable.push(
              unreadableAt(file, call, "`read` takes exactly one list."),
            );
          } else {
            const arg = call.arguments[0]!;
            const read = listRef(file, arg, imports);
            if ("reason" in read) unreadable.push(read);
            else
              out.push({
                ...read,
                site: `${file.rel}:${siteOf(file, call).line}`,
              });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(run.body, visit);
  return out;
}

/** The import a `read(…)` argument names. */
function listRef(
  file: ParsedFile,
  arg: ts.Expression,
  imports: ReturnType<typeof importsOf>,
): { specifier: string; exported: string } | Unreadable {
  if (ts.isIdentifier(arg)) {
    const imp = imports.named.get(arg.text);
    if (imp !== undefined) return imp;
  } else if (
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression)
  ) {
    const spec = imports.namespaces.get(arg.expression.text);
    if (spec !== undefined) return { specifier: spec, exported: arg.name.text };
  }
  return unreadableAt(
    file,
    arg,
    "`read` is given a list not imported by name: import the list from its plugin's barrel and pass it as is.",
  );
}

/**
 * Every `defineSupervisedJob({ name, … run … })` in one file, with the lists
 * its body reads. `displayPath` is repo-relative: relative imports resolve
 * against it.
 */
export function scanJobReads(src: string, displayPath: string): ScannedJob[] {
  if (!PREFILTER_RE.test(src)) return [];
  const file: ParsedFile = {
    rel: displayPath,
    sf: ts.createSourceFile(
      displayPath,
      src,
      ts.ScriptTarget.Latest,
      true,
      displayPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
  const isJobModule = (spec: string): boolean =>
    resolveSpecifier(displayPath, spec, isJobFile) !== null;
  const uses = fileTargetUses<"job">(ts, file, {
    imported: (spec, exported) =>
      exported === MARKER && isJobModule(spec) ? "job" : undefined,
    isTargetModule: isJobModule,
  });
  const imports = importsOf(file.sf);
  const unreadable: Unreadable[] = [...uses.unreadable];
  const out: ScannedJob[] = [];
  const own = isJobFile(displayPath);
  for (const use of uses.found) {
    if (use.kind === "reexport" || use.kind === "reexport-all") {
      if (!own)
        unreadable.push({
          site: use.site,
          reason:
            "`defineSupervisedJob` is re-exported: import it from the supervised-job plugin instead.",
          text: use.kind === "reexport" ? use.as : `* from "${use.specifier}"`,
        });
      continue;
    }
    if (use.kind === "member-call") continue;
    const spec = use.call.arguments[0];
    if (spec === undefined || !ts.isObjectLiteralExpression(spec)) {
      unreadable.push(
        unreadableAt(
          file,
          use.call,
          "`defineSupervisedJob` is not called with an inline spec object.",
        ),
      );
      continue;
    }
    const run = runFunctionOf(file, spec);
    if (run === null) continue;
    if ("reason" in run) {
      unreadable.push(run);
      continue;
    }
    const nameProp = spec.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "name",
    );
    if (nameProp === undefined) {
      unreadable.push(
        unreadableAt(file, spec, "the job's `name` is not written inline."),
      );
      continue;
    }
    const name = literalString(ts, file, nameProp.initializer);
    if (name.kind === "unreadable") {
      unreadable.push(name.unreadable);
      continue;
    }
    out.push({
      job: name.value,
      reads: readsOf(file, run, imports, unreadable),
    });
  }
  failClosed({ found: [], unreadable }, HINT);
  return out;
}

/**
 * The job-reads per-file scan. It imports `typescript` itself, never takes it
 * from its caller: the records are keyed by the npm code this module's
 * closure imports.
 */
export const JOB_READS_SCAN: FileScan<ScannedJob[]> = {
  url: import.meta.url,
  scan: (src, rel) => scanJobReads(src, rel),
};
