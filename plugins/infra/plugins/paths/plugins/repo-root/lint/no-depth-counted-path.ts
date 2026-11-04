import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ASTUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Where a path expression points, relative to the linted file's own
 * directory: `up` levels above it, then down `down` named segments. `null`
 * for an expression the rule cannot read (an identifier, a computed
 * segment) — never reported, never guessed.
 */
interface Location {
  up: number;
  down: string[];
}

/**
 * The anchors a file locates itself by: its directory (`import.meta.dir`,
 * `__dirname`) or its own file (`import.meta.url`, `__filename`, …).
 */
const DIR_ANCHORS = new Set(["dir", "dirname"]);
const FILE_ANCHORS = new Set(["url", "filename", "path"]);

const PATH_FNS = new Set(["join", "resolve", "normalize"]);

/** `x` or `path.x` / `posix.x` — the callee's own name. */
function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return null;
}

/** A segment string the code spells literally: `"../x"`, `` `..` ``, `"../".repeat(3)`. */
function literalText(node: TSESTree.Node): string | null {
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]!.value.cooked ?? null;
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "repeat" &&
    node.arguments.length === 1 &&
    node.arguments[0]!.type === "Literal" &&
    typeof node.arguments[0]!.value === "number"
  ) {
    const base = literalText(node.callee.object);
    return base === null ? null : base.repeat(node.arguments[0]!.value);
  }
  return null;
}

/** Walk `rel` from `from`: `..` climbs, `.` and empty stay, a name descends. */
function walk(from: Location, rel: string): Location {
  if (rel.startsWith("/")) return from; // absolute: not a walk from the file
  let { up } = from;
  const down = [...from.down];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (down.length > 0) down.pop();
      else up++;
    } else down.push(seg);
  }
  return { up, down };
}

/**
 * Where `node` points, if it is a path the rule can follow from the file's
 * own location. A file anchor (`__filename`) points one level BELOW the
 * directory — its own name — so a path walk's first `..` lands on the
 * directory, as `join(__filename, "..")` does; a URL base drops its last
 * segment instead, which `new URL(rel, base)` below models.
 */
type Bound = (id: TSESTree.Identifier) => Location | null;

function locate(node: TSESTree.Node, bound: Bound): Location | null {
  if (node.type === "MetaProperty") return null;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "MetaProperty" &&
    node.property.type === "Identifier"
  ) {
    if (DIR_ANCHORS.has(node.property.name)) return { up: 0, down: [] };
    if (FILE_ANCHORS.has(node.property.name))
      return { up: 0, down: ["<file>"] };
    return null;
  }
  if (node.type === "Identifier") {
    if (node.name === "__dirname") return { up: 0, down: [] };
    if (node.name === "__filename") return { up: 0, down: ["<file>"] };
    return bound(node);
  }
  // `.pathname` / `.href` of a URL: the same place.
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    (node.property.name === "pathname" || node.property.name === "href")
  )
    return locate(node.object, bound);
  if (node.type === "NewExpression") {
    if (
      node.callee.type !== "Identifier" ||
      node.callee.name !== "URL" ||
      node.arguments.length !== 2
    )
      return null;
    const base = locate(node.arguments[1]!, bound);
    const rel = literalText(node.arguments[0]!);
    if (base === null || rel === null) return null;
    // A URL resolves against its base's directory.
    const dir = walk(base, "..");
    return walk(base.down.length > 0 ? dir : base, rel);
  }
  if (node.type !== "CallExpression") return null;
  const name = calleeName(node.callee);
  const [first, ...rest] = node.arguments;
  if (first === undefined) return null;
  if (name === "fileURLToPath" || name === "decodeURIComponent")
    return locate(first, bound);
  if (name === "dirname") {
    const at = locate(first, bound);
    return at === null ? null : walk(at, "..");
  }
  if (name === null || !PATH_FNS.has(name)) return null;
  let at = locate(first, bound);
  if (at === null) return null;
  for (const arg of rest) {
    const rel = literalText(arg);
    if (rel === null) return null;
    at = walk(at, rel);
  }
  return at;
}

/**
 * How many directories the linted file sits below its own plugin's root
 * (`plugins/…/plugins/<name>/`), or `null` outside the plugin tree.
 */
function depthInPlugin(filename: string): number | null {
  const segs = filename.split("/");
  const fileIdx = segs.length - 1;
  for (let i = fileIdx - 2; i >= 0; i--)
    if (segs[i] === "plugins") return fileIdx - (i + 2);
  return null;
}

/**
 * no-depth-counted-path
 *
 * A path built from the file's own location (`import.meta.dir` / `.url`,
 * `__dirname`, …) that climbs out of the file's own plugin encodes how deep
 * the file sits: `join(import.meta.dir, "../../../../..")` is the repo root
 * only while nobody moves the plugin. `./equin plugin move` cannot rewrite
 * it (the path is computed, not written), and nothing fails until it runs —
 * a test can even read the wrong directory and pass.
 *
 * Reach the repo with `REPO_ROOT`
 * (`@plugins/infra/plugins/paths/plugins/repo-root/core`) and a repo-relative
 * path, which the mover does rewrite. A `../` that stays inside the plugin is
 * fine: the plugin moves as a whole.
 */
export default createRule({
  name: "no-depth-counted-path",
  meta: {
    type: "problem",
    docs: {
      description:
        "A path from the file's own location that climbs out of its plugin encodes the file's depth; join a repo-relative path onto REPO_ROOT instead.",
    },
    schema: [],
    messages: {
      escapes:
        "This path climbs {{levels}} level(s) out of its own plugin by counting `../` from the file's location — a count `./equin plugin move` cannot rewrite, which silently points elsewhere once the plugin's depth changes. Join a repo-relative path onto `REPO_ROOT` (`@plugins/infra/plugins/paths/plugins/repo-root/core`) instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    const depth = depthInPlugin(context.filename);
    if (depth === null) return {};
    /**
     * A `const` of the file bound to a location (`const HERE =
     * dirname(fileURLToPath(import.meta.url))`) is followed — unless the
     * binding itself escapes: it is reported where it is made, once.
     */
    const following = new Set<TSESTree.Node>();
    const bound: Bound = (id) => {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(id),
        id,
      );
      const def = variable?.defs[0];
      if (
        def?.type !== "Variable" ||
        def.parent.kind !== "const" ||
        def.node.init === null ||
        following.has(def.node)
      )
        return null;
      following.add(def.node);
      const at = locate(def.node.init, bound);
      following.delete(def.node);
      return at !== null && at.up <= depth ? at : null;
    };
    const escape = (node: TSESTree.Node): number => {
      const at = locate(node, bound);
      return at === null ? 0 : at.up - depth;
    };
    const check = (node: TSESTree.CallExpression | TSESTree.NewExpression) => {
      const levels = escape(node);
      if (levels <= 0) return;
      // Report one path once: at its outermost call, so an enclosing call
      // or `new` that carries the same escape (through `.href` too) wins.
      for (
        let up: TSESTree.Node | undefined = node.parent;
        up !== undefined &&
        (up.type === "CallExpression" ||
          up.type === "NewExpression" ||
          up.type === "MemberExpression") &&
        escape(up) > 0;
        up = up.parent
      )
        if (up.type !== "MemberExpression") return;
      context.report({
        node,
        messageId: "escapes",
        data: { levels: String(levels) },
      });
    };
    return { CallExpression: check, NewExpression: check };
  },
});
