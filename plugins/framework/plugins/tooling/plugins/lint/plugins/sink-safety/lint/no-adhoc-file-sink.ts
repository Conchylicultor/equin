import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** The fs modules whose append/stream writers create an unbounded durable sink. */
const FS_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
]);

/** The append/stream writers themselves — the ways to accumulate bytes on disk. */
const APPEND_NAMES = new Set([
  "appendFile",
  "appendFileSync",
  "createWriteStream",
]);

/** Whole-file writers that can be turned into an append via a `{ flag: "a" }` option. */
const WHOLEFILE_WRITE_NAMES = new Set(["writeFile", "writeFileSync"]);

/** Whether a property key (Identifier or string Literal) is `name`. */
function keyIs(prop: TSESTree.Property, name: string): boolean {
  const k = prop.key;
  if (k.type === "Identifier") return k.name === name;
  if (k.type === "Literal" && typeof k.value === "string")
    return k.value === name;
  return false;
}

/**
 * Whether an options object literal carries `flag`/`flags: "a…"` — the append
 * mode strings (`"a"`, `"ax"`, `"a+"`, `"as"`). This is the one way to smuggle an
 * append through the sanctioned whole-file API (`writeFileSync(f, x, {flag:"a"})`).
 */
function hasAppendFlag(arg: TSESTree.Node): boolean {
  if (arg.type !== "ObjectExpression") return false;
  for (const p of arg.properties) {
    if (p.type !== "Property") continue;
    if (!keyIs(p, "flag") && !keyIs(p, "flags")) continue;
    if (
      p.value.type === "Literal" &&
      typeof p.value.value === "string" &&
      /^a/.test(p.value.value)
    ) {
      return true;
    }
  }
  return false;
}

/** The final identifier name of a callee: `writeFileSync`, `Bun.write`'s `write`, `fs.appendFileSync`'s `appendFileSync`. */
function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/** Whether a member expression is `Bun.file(...)` — the head of the Bun stream-writer chain. */
function isBunFileCall(node: TSESTree.Node): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Bun" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "file"
  );
}

export default createRule({
  name: "no-adhoc-file-sink",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow append-mode filesystem writers outside the file-sink plugin — a " +
        "hand-rolled durable sink escapes the declared/bounded/enumerable invariant.",
    },
    schema: [],
    messages: {
      adhocFileSink:
        "Append-mode file writes create a durable sink that grows without bound " +
        "and is invisible to the growth-bound registry — the exact shape that " +
        "produced flight-recorder.jsonl / stall-profiles.jsonl. If this is perf " +
        "EVIDENCE, use captureTrace() / defineTraceEventClass() " +
        "(@plugins/debug/plugins/trace/plugins/engine/server). If it is a perf " +
        "ALERT, use recordReport() (@plugins/reports/plugins/engine/server). If it is a genuine " +
        "durable log or artifact, declare it with defineLogSink() " +
        "(@plugins/primitives/plugins/log-channels/server) or defineFileSink() " +
        "(@plugins/infra/plugins/file-sink/core) — both register a rotate bound " +
        "so the sink is enumerable in getFileSinks(). Whole-file writes " +
        "(writeFileSync/Bun.write) are fine; appends are not. Type-only imports are allowed.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Local names bound to an fs namespace/default import (`import * as fs`,
    // `import fsp from "node:fs/promises"`) — member access on these is checked.
    const fsLocals = new Set<string>();

    return {
      ImportDeclaration(node) {
        // Type-only imports never load a value — always allowed.
        if (node.importKind === "type") return;
        if (typeof node.source.value !== "string") return;
        if (!FS_MODULES.has(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            // `import { appendFileSync }` / `import { appendFileSync as af }` —
            // report at the specifier, so aliasing is covered regardless of local name.
            if (
              spec.imported.type === "Identifier" &&
              APPEND_NAMES.has(spec.imported.name)
            ) {
              context.report({ node: spec, messageId: "adhocFileSink" });
            }
          } else if (
            spec.type === "ImportNamespaceSpecifier" ||
            spec.type === "ImportDefaultSpecifier"
          ) {
            // `import * as fs` / `import fs from "fs"` — track the local; flag its
            // append-member access below.
            fsLocals.add(spec.local.name);
          }
        }
      },
      // Re-export laundering: `export { appendFileSync } from "fs"`.
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
        if (!node.source || typeof node.source.value !== "string") return;
        if (!FS_MODULES.has(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (
            spec.local.type === "Identifier" &&
            APPEND_NAMES.has(spec.local.name)
          ) {
            context.report({ node: spec, messageId: "adhocFileSink" });
          }
        }
      },
      // `fs.appendFileSync(...)` / `fs["appendFileSync"](...)` on a tracked fs local.
      MemberExpression(node) {
        if (node.object.type !== "Identifier") return;
        if (!fsLocals.has(node.object.name)) return;
        const prop =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop && APPEND_NAMES.has(prop)) {
          context.report({ node, messageId: "adhocFileSink" });
        }
      },
      CallExpression(node) {
        // `Bun.file(x).writer()` — the Bun stream-sink chain (a global; no import).
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "writer" &&
          isBunFileCall(node.callee.object)
        ) {
          context.report({ node, messageId: "adhocFileSink" });
          return;
        }
        // `writeFileSync(f, x, { flag: "a" })` / `Bun.write(f, x, { flag: "a" })` —
        // an append smuggled through a sanctioned whole-file writer.
        const name = calleeName(node.callee);
        const isBunWrite =
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Bun" &&
          name === "write";
        if (name && (WHOLEFILE_WRITE_NAMES.has(name) || isBunWrite)) {
          const lastArg = node.arguments[node.arguments.length - 1];
          if (lastArg && hasAppendFlag(lastArg)) {
            context.report({ node: lastArg, messageId: "adhocFileSink" });
          }
        }
      },
    };
  },
});
