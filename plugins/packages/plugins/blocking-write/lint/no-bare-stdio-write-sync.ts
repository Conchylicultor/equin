import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const WRITER_MODULE = "@plugins/packages/plugins/blocking-write/machine";

/** `1`, `2`, `process.stdout.fd`, `process.stderr.fd`. */
function isStdioFd(node: TSESTree.Node | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "Literal") return node.value === 1 || node.value === 2;
  if (
    node.type !== "MemberExpression" ||
    node.computed ||
    node.property.type !== "Identifier" ||
    node.property.name !== "fd"
  )
    return false;
  const stream = node.object;
  return (
    stream.type === "MemberExpression" &&
    !stream.computed &&
    stream.object.type === "Identifier" &&
    stream.object.name === "process" &&
    stream.property.type === "Identifier" &&
    (stream.property.name === "stdout" || stream.property.name === "stderr")
  );
}

/** `writeSync(…)` or `<anything>.writeSync(…)`. */
function isWriteSync(callee: TSESTree.Node): boolean {
  if (callee.type === "Identifier") return callee.name === "writeSync";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "writeSync"
  );
}

/**
 * no-bare-stdio-write-sync
 *
 * Bun sets O_NONBLOCK on a piped stdout / stderr the first time
 * `process.stdout` / `process.stderr` is touched, so a bare `writeSync(1, …)`
 * into a pipe whose reader is slower (`./equin build | tail`) throws EAGAIN
 * once the pipe is full, or writes part of the buffer and returns the short
 * count — a build crashed on it instead of printing its verdict (2026-11-15).
 * `writeAllSync` (packages/blocking-write) waits the pipe out and writes it
 * all. Syntactic: a call named `writeSync` whose fd is written as `1`, `2` or
 * `process.stdout.fd` / `process.stderr.fd`.
 */
export default createRule({
  name: "no-bare-stdio-write-sync",
  meta: {
    type: "problem",
    docs: {
      description:
        "A synchronous write to stdout / stderr is writeAllSync (packages/blocking-write), never a bare writeSync: the fd may be non-blocking.",
    },
    schema: [],
    messages: {
      bare: `A bare writeSync to stdout / stderr throws EAGAIN (or writes only part of the buffer) once a piped reader falls behind: Bun makes a piped stdout non-blocking. Use \`writeAllSync(fd, data)\` from "${WRITER_MODULE}"; code that cannot reach a machine barrel writes \`await Bun.write(Bun.stdout, data)\` instead.`,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (isWriteSync(node.callee) && isStdioFd(node.arguments[0]))
          context.report({ node, messageId: "bare" });
      },
    };
  },
});
