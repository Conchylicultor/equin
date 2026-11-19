import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import { aboveFloorTable, type AboveFloor } from "./above-floor";
import { isBrowserBuilt } from "./browser-built";
import { floorInWords } from "./browser-floor";
import { regexpAboveFloor } from "./regexp-above-floor";

const createRule = lintRuleCreator(import.meta.url);

/** Owners whose members the compat data files under another owner's name. */
const TYPED_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * The compat-data owners a TypeScript declaration's container stands for:
 * `SetConstructor` → `Set` (its statics), `ReadonlyArray` → `Array`, a typed
 * array → itself and `TypedArray`.
 */
function ownerNames(container: string): string[] {
  let name = container;
  if (name.endsWith("Constructor") && name.length > "Constructor".length)
    name = name.slice(0, -"Constructor".length);
  if (/^Readonly(Array|Set|Map)$/.test(name))
    name = name.slice("Readonly".length);
  return TYPED_ARRAYS.has(name) ? [name, "TypedArray"] : [name];
}

/** Whether a declaration is a global ambient one a package's types declare. */
function isAmbientGlobal(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  if (!sf.isDeclarationFile || !sf.fileName.includes("/node_modules/"))
    return false;
  for (let n: ts.Node = node; ; n = n.parent) {
    const parent = n.parent as ts.Node | undefined;
    if (parent === undefined) return false;
    if (ts.isSourceFile(parent)) return !ts.isExternalModule(parent);
    if (
      ts.isModuleBlock(parent) &&
      ts.isModuleDeclaration(parent.parent) &&
      parent.parent.name.getText() === "global"
    )
      return true;
  }
}

/**
 * The name of the interface / class / `declare var X: {…}` / `declare
 * namespace X { var m }` holding a member declaration.
 */
function containerName(decl: ts.Declaration): string | undefined {
  const parent = decl.parent as ts.Node | undefined;
  if (parent === undefined) return undefined;
  // `declare namespace Intl { var Segmenter: … }`: the declaration sits in a
  // variable statement of the namespace's block.
  if (
    ts.isVariableDeclarationList(parent) &&
    ts.isVariableStatement(parent.parent) &&
    ts.isModuleBlock(parent.parent.parent) &&
    ts.isModuleDeclaration(parent.parent.parent.parent) &&
    ts.isIdentifier(parent.parent.parent.parent.name)
  )
    return parent.parent.parent.parent.name.text;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))
    return parent.name?.text;
  if (
    ts.isTypeLiteralNode(parent) &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
  )
    return parent.parent.name.text;
  return undefined;
}

/** The nodes on the path from `node` up to the root, each with its child on the path. */
function* ancestry(
  node: TSESTree.Node,
): Generator<{ parent: TSESTree.Node; child: TSESTree.Node }> {
  // The Program's parent is null at runtime, though typed otherwise.
  for (
    let child: TSESTree.Node = node;
    (child.parent as TSESTree.Node | null | undefined) != null;
    child = child.parent!
  )
    yield { parent: child.parent!, child };
}

/**
 * Whether a use is a feature test or sits behind one. A test MENTIONS the
 * feature when any expression in it reads as the use does (`typeof X`,
 * `"name" in obj`, `if (obj.name)`, `X !== undefined`); the use is behind it
 * in a branch of an `if` or a `?:` on it, the right of an `&&` after it, or
 * after an early `return` / `throw` on it. Its sense is not checked: an
 * inverted test is a bug of another kind.
 *
 * `typeof X`, `X?.()`, and a read that is not called inside a test (or on the
 * left of `&&` / `||` / `??` — `x.newer ?? fallback`) are tests themselves.
 */
function isFeatureTested(
  node: TSESTree.Node,
  text: (n: TSESTree.Node) => string,
  member: string | null,
): boolean {
  const own = text(node);
  const mentions = (test: TSESTree.Node): boolean => {
    let found = false;
    const visit = (n: TSESTree.Node): void => {
      if (found) return;
      if (
        (n.type === "Identifier" || n.type === "MemberExpression") &&
        text(n) === own
      ) {
        found = true;
        return;
      }
      if (
        member !== null &&
        n.type === "BinaryExpression" &&
        n.operator === "in" &&
        n.left.type === "Literal" &&
        n.left.value === member
      ) {
        found = true;
        return;
      }
      for (const [key, value] of Object.entries(n)) {
        if (key === "parent") continue;
        for (const c of Array.isArray(value) ? value : [value])
          if (c !== null && typeof c === "object" && "type" in c)
            visit(c as TSESTree.Node);
      }
    };
    visit(test);
    return found;
  };
  const parent = node.parent;
  if (parent?.type === "UnaryExpression" && parent.operator === "typeof")
    return true;
  if (
    parent?.type === "CallExpression" &&
    parent.callee === node &&
    parent.optional
  )
    return true;
  const called =
    (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
    parent.callee === node;
  for (const { parent: p, child } of ancestry(node)) {
    // A plain read inside a test is the test itself.
    if (!called) {
      if (
        (p.type === "IfStatement" || p.type === "ConditionalExpression") &&
        p.test === child
      )
        return true;
      if (p.type === "LogicalExpression" && p.left === child) return true;
    }
    if (
      (p.type === "IfStatement" || p.type === "ConditionalExpression") &&
      p.test !== child &&
      mentions(p.test)
    )
      return true;
    if (
      p.type === "LogicalExpression" &&
      p.operator === "&&" &&
      p.right === child &&
      mentions(p.left)
    )
      return true;
    if (p.type === "BlockStatement" || p.type === "Program") {
      const body = p.body as TSESTree.Node[];
      for (const statement of body.slice(0, body.indexOf(child))) {
        if (statement.type !== "IfStatement" || !mentions(statement.test))
          continue;
        const exit =
          statement.consequent.type === "BlockStatement"
            ? statement.consequent.body.at(-1)
            : statement.consequent;
        if (exit?.type === "ReturnStatement" || exit?.type === "ThrowStatement")
          return true;
      }
    }
  }
  return false;
}

/**
 * no-api-above-floor
 *
 * A browser-built file (a plugin's `web/`, `core/`, `shared/`, `exhibits/`)
 * uses only built-ins every floor browser has (`BROWSER_FLOOR`: Chrome / Edge
 * 111, Firefox 115, Safari / iOS Safari 16.4) — or feature-tests one first.
 *
 * TypeScript's lib declares the newest built-ins whatever the browsers in the
 * wild run, so `tsc` never catches one: on 2026-11-19 a visitor on an older
 * Safari crashed equin.ai's home page on `URL.canParse` (Safari 17). The rule
 * resolves what a member access (`URL.canParse`, `set.union`) or a global
 * (`structuredClone`, `new URLPattern`) names in the type environment, and
 * when that is a built-in — declared globally by a package's types — whose
 * MDN browser-compat-data entry a floor browser lacks, reports it.
 *
 * Only names the data lists as newer are ever resolved (a syntactic gate on
 * the property name), so the checker is asked about few accesses.
 *
 * Regular expressions too: a regex literal, or `new RegExp(source, flags)`
 * with literal flags, whose flags (`v` — Safari 17) or syntax (modifiers
 * `(?i:…)`, duplicate named groups) a floor browser lacks — read from the
 * same data (`RegExp.unicodeSets`, `javascript.regular_expressions.*`) and
 * parsed with regexpp. A flag behind a feature test of its `RegExp` member
 * (`"unicodeSets" in RegExp.prototype`) passes.
 *
 * Out of reach of the rule, by design: a member reached through a computed
 * key or a destructuring, the syntax of a regex whose source is computed, and
 * a regex whose flags are.
 *
 * Which `server/` and `bin/` files ship to a browser (the demo's in-browser
 * server boots them in a worker) is a fact of the browser host's whole
 * closure, which a per-file rule cannot see: the `browser-floor:worker-closure`
 * check computes it and runs this rule on those files with
 * `{ shipsToBrowser: true }`, so a server file no browser loads stays free to
 * use newer built-ins.
 */
export default createRule({
  name: "no-api-above-floor",
  meta: {
    type: "problem",
    docs: {
      description:
        "Browser-built code uses only built-ins every browser of the floor (BROWSER_FLOOR) has, per MDN's browser-compat-data: a newer one crashes the page for visitors on older browsers.",
      requiresTypeChecking: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          // The file ships to a browser whatever folder it sits in — set by
          // the `browser-floor:worker-closure` check, never by the repo config.
          shipsToBrowser: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      regexpAboveFloor:
        'This regular expression uses {{what}}, newer than equin\'s browser floor — missing in {{needs}} ({{key}}). Browser code runs on {{floor}} (browser-floor\'s BROWSER_FLOOR): an older browser throws where the regex is created — a literal is a parse error of the whole module, a `new RegExp(…)` throws "Invalid flags supplied to RegExp constructor" — so every importer of the module fails to load (equin.ai\'s page editor did, on emoji\'s `v` flag, 2026-11-19). Spell it without the feature, or build it behind a feature test of its flag (`"unicodeSets" in RegExp.prototype ? new RegExp(…, "v") : fallback`).',
      regexpInvalid:
        "This regular expression does not parse at ES2025 ({{error}}): it is invalid, or uses syntax newer than any browser equin supports (browser floor: {{floor}}).",
      aboveFloor:
        '`{{name}}` is newer than equin\'s browser floor — missing in {{needs}} ({{key}}). Browser code runs on {{floor}} (browser-floor\'s BROWSER_FLOOR): a visitor on an older browser crashes on it (equin.ai\'s home page did on `URL.canParse`, 2026-11-19). Use its floor-safe spelling from `@plugins/packages/plugins/floor-compat/core` when it has one (`canParseUrl`, `parseUrl`, `jsonResponse`, `promiseWithResolvers`), else feature-test it (`typeof X === "function"`, `"name" in obj`) and keep a fallback — a use behind the test passes.',
    },
  },
  defaultOptions: [{ shipsToBrowser: false }] as [{ shipsToBrowser?: boolean }],
  create(context, [{ shipsToBrowser }]) {
    if (
      shipsToBrowser !== true &&
      !isBrowserBuilt(context.filename, context.cwd)
    )
      return {};
    const table = aboveFloorTable();
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const report = (node: TSESTree.Node, name: string, hit: AboveFloor) =>
      context.report({
        node,
        messageId: "aboveFloor",
        data: { name, needs: hit.needs, key: hit.key, floor: floorInWords() },
      });

    const symbolOf = (node: TSESTree.Node): ts.Symbol | undefined =>
      checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node));

    /** The newer-than-floor built-in a member access names, if it does. */
    const memberHit = (
      property: TSESTree.Identifier,
    ): AboveFloor | undefined => {
      const name = property.name;
      if (!table.memberNames.has(name) && !table.globals.has(name))
        return undefined;
      const symbol = symbolOf(property);
      for (const decl of symbol?.declarations ?? []) {
        const container = containerName(decl);
        if (container === undefined || !isAmbientGlobal(decl.parent)) continue;
        for (const owner of ownerNames(container)) {
          const hit = table.members.get(owner)?.get(name);
          if (hit !== undefined) return hit;
        }
        // A page or worker global reached as a member (`window.x`,
        // `globalThis.x`), declared on a global-scope mixin.
        if (
          /^(Window|WorkerGlobalScope|WindowOrWorkerGlobalScope)$/.test(
            container,
          )
        ) {
          const hit = table.globals.get(name);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    };

    /** The newer-than-floor global an identifier names, if it does. */
    const globalHit = (id: TSESTree.Identifier): AboveFloor | undefined => {
      const hit = table.globals.get(id.name);
      if (hit === undefined) return undefined;
      const decls = symbolOf(id)?.declarations ?? [];
      return decls.length > 0 && decls.every(isAmbientGlobal) ? hit : undefined;
    };

    const text = (n: TSESTree.Node) => context.sourceCode.getText(n);

    const checkGlobal = (node: TSESTree.Node) => {
      if (node.type !== "Identifier") return;
      const hit = globalHit(node);
      if (hit === undefined || isFeatureTested(node, text, null)) return;
      report(node, node.name, hit);
    };

    const regexpCheck = (
      node: TSESTree.Node,
      pattern: string | undefined,
      flags: string,
    ) => {
      const verdict = regexpAboveFloor(pattern ?? "", flags, table);
      if (!verdict.ok) {
        context.report({
          node,
          messageId: "regexpInvalid",
          data: { error: verdict.error, floor: floorInWords() },
        });
        return;
      }
      for (const { what, hit, member } of verdict.hits) {
        if (member !== undefined && isFeatureTested(node, text, member))
          continue;
        context.report({
          node,
          messageId: "regexpAboveFloor",
          data: { what, needs: hit.needs, key: hit.key, floor: floorInWords() },
        });
      }
    };

    /** A string a regex argument spells as a literal, if it does. */
    const literalString = (
      n: TSESTree.Node | undefined,
    ): string | undefined => {
      if (n?.type === "Literal" && typeof n.value === "string") return n.value;
      if (n?.type === "TemplateLiteral" && n.expressions.length === 0)
        return n.quasis[0]?.value.cooked ?? undefined;
      return undefined;
    };

    /**
     * `new RegExp(source, flags)` / `RegExp(…)` on the global constructor,
     * when its flags are spelled as a literal (its source too, for syntax). A regex
     * literal source is checked as a literal already (it is created first);
     * the call is checked again only when it passes other flags.
     */
    const checkRegExpCall = (
      node: TSESTree.CallExpression | TSESTree.NewExpression,
    ) => {
      if (node.callee.type !== "Identifier" || node.callee.name !== "RegExp")
        return;
      const decls = symbolOf(node.callee)?.declarations ?? [];
      if (decls.length === 0 || !decls.every(isAmbientGlobal)) return;
      const [source, flagsArg] = node.arguments;
      const regexSource = source?.type === "Literal" && "regex" in source;
      if (regexSource && flagsArg === undefined) return;
      const pattern = regexSource
        ? source.regex.pattern
        : literalString(source);
      const flags = flagsArg === undefined ? "" : literalString(flagsArg);
      if (flags === undefined) return;
      // A computed source still has its literal flags checked.
      regexpCheck(node, pattern, flags);
    };

    return {
      Literal(node) {
        if ("regex" in node)
          regexpCheck(node, node.regex.pattern, node.regex.flags);
      },
      MemberExpression(node) {
        if (node.object.type === "Identifier") checkGlobal(node.object);
        if (node.computed || node.property.type !== "Identifier") return;
        const hit = memberHit(node.property);
        if (hit === undefined) return;
        if (isFeatureTested(node, text, node.property.name)) return;
        const receiver =
          node.object.type === "Identifier" ? `${node.object.name}.` : ".";
        report(node.property, `${receiver}${node.property.name}`, hit);
      },
      CallExpression(node) {
        checkGlobal(node.callee);
        checkRegExpCall(node);
      },
      NewExpression(node) {
        checkGlobal(node.callee);
        checkRegExpCall(node);
      },
    };
  },
});
