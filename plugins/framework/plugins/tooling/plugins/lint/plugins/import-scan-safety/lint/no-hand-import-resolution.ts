import type { TSESTree } from "@typescript-eslint/utils";
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/** The repo's one path alias. */
const ALIAS = "@plugins/";

type Node = TSESTree.Node;

const stringValue = (n: Node | undefined): string | undefined =>
  n?.type === "Literal" && typeof n.value === "string" ? n.value : undefined;

/**
 * Whether `n` is the alias's length: `"@plugins/".length`, `ALIAS.length`
 * where `ALIAS` is a const initialized to `"@plugins/"`, or the number 9.
 */
function isAliasLength(
  n: Node | undefined,
  constOf: (id: string) => Node | undefined,
): boolean {
  if (n === undefined) return false;
  if (n.type === "Literal") return n.value === ALIAS.length;
  if (
    n.type !== "MemberExpression" ||
    n.computed ||
    n.property.type !== "Identifier" ||
    n.property.name !== "length"
  )
    return false;
  if (stringValue(n.object) === ALIAS) return true;
  return (
    n.object.type === "Identifier" &&
    stringValue(constOf(n.object.name)) === ALIAS
  );
}

/** A string whose last segment is the repo's `plugins/` directory. */
const endsInPluginsDir = (s: string | undefined): boolean =>
  s !== undefined && /(^|\/)plugins\/$/.test(s);

/**
 * Whether the value at `n` becomes a path under the repo's `plugins/`
 * directory: interpolated right after `plugins/` in a template, appended to a
 * string ending in `plugins/`, or joined with a `"plugins"` segment.
 */
function landsInPluginsDir(n: Node): boolean {
  const p = n.parent;
  if (p === undefined) return false;
  if (p.type === "TemplateLiteral") {
    const i = p.expressions.indexOf(n as TSESTree.Expression);
    return i >= 0 && endsInPluginsDir(p.quasis[i]!.value.cooked ?? undefined);
  }
  if (p.type === "BinaryExpression" && p.operator === "+" && p.right === n)
    return endsInPluginsDir(stringValue(p.left));
  if (
    p.type === "CallExpression" &&
    p.arguments.includes(n as TSESTree.CallExpressionArgument)
  )
    return p.arguments.some((a) => stringValue(a) === "plugins");
  return false;
}

/** A name that holds an import specifier: `spec`, `specifier`, `importSpec`, `rawSpecifier`, … */
const SPECIFIER_NAME = /spec(ifier)?$/i;

/** The name `n` reads: an identifier, or a member's property (`imp.specifier`). */
function nameOf(n: Node | undefined): string | undefined {
  if (n?.type === "Identifier") return n.name;
  if (
    n?.type === "MemberExpression" &&
    !n.computed &&
    n.property.type === "Identifier"
  )
    return n.property.name;
  return undefined;
}

/** The name a call's callee reads (`join`, `posix.join`, `relJoin`). */
const calleeName = (n: Node | undefined): string | undefined =>
  n?.type === "CallExpression" ? nameOf(n.callee) : undefined;

/** A directory-of-a-file call: `dirname(x)`, `posix.dirname(x)`, `relDirname(x)`. */
const isDirnameCall = (n: Node | undefined): boolean =>
  /dirname$/i.test(calleeName(n) ?? "");

/** A directory-of-a-file value: a {@link isDirnameCall}, or a name ending in `dir` / `dirname`. */
const isDirValue = (n: Node | undefined): boolean =>
  isDirnameCall(n) || /dir(name)?$/i.test(nameOf(n) ?? "");

export default createRule({
  name: "no-hand-import-resolution",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow resolving an import specifier to a repo file by hand — read resolved imports off the plugin-records module graph.",
    },
    schema: [],
    messages: {
      handResolution:
        "This maps an `@plugins/…` import specifier onto the repo's `plugins/` directory — a hand-rolled import resolver beside the module graph. " +
        "Each one guesses the extensions, index files, queries and aliases a little differently, and re-parses and re-resolves the tree on every pass. " +
        "Read resolved imports off the plugin-records module graph (`@plugins/plugin-meta/plugins/plugin-records/core`): " +
        "`fileSetImports` / `fileSetRuntimeReach` / `fileSetClosure` for which modules a file loads, " +
        "`fileSetBindings` (`plugin-records/plugins/bindings/core`) for each edge's bound names, or a `ModuleNode`'s `staticImports` / `dynamicImports` for spec → file. " +
        "A specifier read for its own text (a plugin id, a barrel folder) is not resolution: keep it a plugin path, not a file path.",
      relativeResolution:
        "This joins an import specifier onto its importer's directory — a hand-rolled relative import resolver beside the module graph. " +
        "Read resolved imports off the plugin-records module graph (`fileSetImportTargets` / `fileSetImports` / `fileSetBindings`). " +
        "For a specifier the graph has no edge for (an `import type`, a CSS `@import`, a lint rule's one file), use the graph's own resolver: " +
        "`specifierPath` (the path a specifier names) or `resolveSpecifier` (the file of a set it resolves to) from `@plugins/plugin-meta/plugins/plugin-records/plugins/specifier/core`.",
    },
  },
  defaultOptions: [],
  create(context) {
    /** The initializer of the `const` `name` names where `at` reads it, if any. */
    const constAt =
      (at: Node) =>
      (name: string): Node | undefined => {
        for (
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(at);
          scope !== null;
          scope = scope.upper
        ) {
          const def = scope.set.get(name)?.defs[0];
          if (def === undefined) continue;
          return def.node.type === "VariableDeclarator" &&
            def.parent?.type === "VariableDeclaration" &&
            def.parent.kind === "const"
            ? (def.node.init ?? undefined)
            : undefined;
        }
        return undefined;
      };
    return {
      // `${dir}/${specifier}`: a specifier appended to a directory.
      TemplateLiteral(node) {
        node.expressions.forEach((e, i) => {
          if (
            i > 0 &&
            SPECIFIER_NAME.test(nameOf(e) ?? "") &&
            node.quasis[i]!.value.cooked === "/" &&
            isDirValue(node.expressions[i - 1])
          )
            context.report({ node, messageId: "relativeResolution" });
        });
      },
      CallExpression(node) {
        // `join(dirname(importer), spec)`, `posix.join(posix.dirname(f), specifier)`,
        // `relJoin(relDirname(from), spec)`, `resolve(dir, spec)`.
        if (
          /(join|resolve)$/i.test(calleeName(node) ?? "") &&
          isDirValue(node.arguments[0]) &&
          node.arguments
            .slice(1)
            .some((a) => SPECIFIER_NAME.test(nameOf(a) ?? ""))
        ) {
          context.report({ node, messageId: "relativeResolution" });
          return;
        }
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier"
        )
          return;
        const method = callee.property.name;
        // `spec.replace("@plugins/", "plugins/")`, `.replace(/^@plugins\//, "plugins/")`.
        if (method === "replace" || method === "replaceAll") {
          const [from, to] = node.arguments;
          const fromAlias =
            stringValue(from) === ALIAS ||
            (from?.type === "Literal" &&
              "regex" in from &&
              /^\^?@plugins\\?\/$/.test(from.regex.pattern));
          if (fromAlias && endsInPluginsDir(stringValue(to)))
            context.report({ node, messageId: "handResolution" });
          return;
        }
        // `plugins/${spec.slice("@plugins/".length)}`, and the same through a const.
        if (method !== "slice" && method !== "substring" && method !== "substr")
          return;
        if (!isAliasLength(node.arguments[0], constAt(node))) return;
        if (landsInPluginsDir(node)) {
          context.report({ node, messageId: "handResolution" });
          return;
        }
        const decl = node.parent;
        if (
          decl?.type !== "VariableDeclarator" ||
          decl.id.type !== "Identifier"
        )
          return;
        const variable = context.sourceCode
          .getDeclaredVariables(decl)
          .find((v) => v.name === (decl.id as TSESTree.Identifier).name);
        for (const ref of variable?.references ?? []) {
          if (ref.init) continue;
          if (landsInPluginsDir(ref.identifier as Node)) {
            context.report({ node, messageId: "handResolution" });
            return;
          }
        }
      },
    };
  },
});
