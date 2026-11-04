import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import { OWNED_FD_MODULE } from "./no-raw-fd-close";

const createRule = lintRuleCreator(import.meta.url);

const STDIO_KEYS = new Set(["stdin", "stdout", "stderr"]);
const SPAWN_CALLEES = new Set(["spawn", "spawnSync"]);

function keyName(prop: TSESTree.Property): string | null {
  if (!prop.computed && prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string")
    return prop.key.value;
  return null;
}

/** `Bun.spawn(…)`, `spawn(…)`, `cp.spawnSync(…)` — any call named spawn / spawnSync. */
function isSpawnCall(node: TSESTree.Node | undefined): boolean {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return SPAWN_CALLEES.has(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    SPAWN_CALLEES.has(callee.property.name)
  );
}

/**
 * no-raw-spawn-stdio-fd
 *
 * A child's stdio given as a bare descriptor number (`stdout: fd`,
 * `stdio: [..., fd]`) has no owner to close it exactly once — and the
 * descriptors handed to children are where the 2026-09 double closes lived
 * (`spawnCaptured`'s temp-file fds were the first victim). A descriptor passed
 * to a spawn is an `OwnedFd`'s `.fd` (`packages/owned-fd`), whose owner closes
 * it once, after the spawn. Type-aware: reported when a stdio value's type
 * includes `number` and the value is not `<OwnedFd>.fd` (a type named
 * `OwnedFd` — by name, so a look-alike would pass), inside the options object of a call
 * named `spawn` / `spawnSync` (`Bun.spawn`, `child_process`).
 *
 * Reads what is written at the call: options built in a variable and passed
 * by name, or a `stdio` array held in a variable, are not followed.
 */
export default createRule({
  name: "no-raw-spawn-stdio-fd",
  meta: {
    type: "problem",
    docs: {
      description:
        "A spawn's stdio descriptor is an OwnedFd's .fd (packages/owned-fd), never a bare number, so exactly one owner closes it once.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      rawFd: `This child's stdio is a bare descriptor number, which nothing owns: it can be closed twice, killing whatever reused the number. Open it with \`openOwnedFd(…)\` (or \`adoptFd(fd)\`) from "${OWNED_FD_MODULE}", pass its \`.fd\`, and \`close()\` it after the spawn.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const isOwnedFdMember = (value: TSESTree.Node): boolean => {
      if (
        value.type !== "MemberExpression" ||
        value.computed ||
        value.property.type !== "Identifier" ||
        value.property.name !== "fd"
      )
        return false;
      const type = services.getTypeAtLocation(value.object);
      const nonNull = checker.getNonNullableType(type);
      return (
        (nonNull.getSymbol() ?? nonNull.aliasSymbol)?.getName() === "OwnedFd"
      );
    };

    const includesNumber = (value: TSESTree.Node): boolean => {
      const type = services.getTypeAtLocation(value);
      const parts = type.isUnion() ? type.types : [type];
      return parts.some((t) => (t.getFlags() & ts.TypeFlags.NumberLike) !== 0);
    };

    // Judged leaf by leaf: `owned?.fd ?? "ignore"`, `x ? owned.fd : "pipe"`.
    const check = (value: TSESTree.Node): void => {
      if (value.type === "SpreadElement") return;
      if (value.type === "ChainExpression") return check(value.expression);
      if (value.type === "LogicalExpression") {
        check(value.left);
        return check(value.right);
      }
      if (value.type === "ConditionalExpression") {
        check(value.consequent);
        return check(value.alternate);
      }
      if (!includesNumber(value) || isOwnedFdMember(value)) return;
      context.report({ node: value, messageId: "rawFd" });
    };

    return {
      Property(prop) {
        const object = prop.parent;
        if (object?.type !== "ObjectExpression" || !isSpawnCall(object.parent))
          return;
        const key = keyName(prop);
        if (key === null) return;
        if (STDIO_KEYS.has(key)) check(prop.value);
        else if (key === "stdio" && prop.value.type === "ArrayExpression") {
          for (const el of prop.value.elements) if (el) check(el);
        }
      },
    };
  },
});
