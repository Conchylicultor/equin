import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** A command word naming the machine's Python: `python`, `python3`, `/usr/bin/python3.12`. */
const PYTHON_COMMAND = /^(?:\/usr(?:\/local)?\/bin\/)?python(?:3(?:\.\d+)?)?$/;

/**
 * A shell string that runs the machine's Python by name: after a command
 * separator, `exec` or `env`, or by its path. Deliberately not "starts with
 * python": prose such as `python -m x: exited 3` is not a command.
 */
const PYTHON_IN_SHELL =
  /(?:[;&|(]\s*|\bexec\s+|\/usr\/bin\/env\s+)python(?:3(?:\.\d+)?)?(?=[ \t]+\S)|\/usr\/bin\/(?:env\s+)?python/;

/** The script of `sh -c "<script>"` starting with Python: `python3 -m x`. */
const PYTHON_SCRIPT = /^\s*python(?:3(?:\.\d+)?)?(?=\s|$)/;

function stringValue(node: TSESTree.Node | null): string | null {
  if (node === null) return null;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((q) => q.value.cooked).join("${}");
  }
  return null;
}

/**
 * Bans running the machine's own Python. On macOS `/usr/bin/python3` is an
 * xcode-select shim: run under a name it does not know (a `bin/python` symlink
 * to it), or on a machine without the Command Line Tools, it pops Apple's
 * "install the command line developer tools" dialog on the user's screen. The
 * python kind of infra/deps runs uv-managed CPythons only (`pythonEnv` +
 * `runPython`, or `uv` with `uvEnv()`), which never touch the shim.
 */
export default createRule({
  name: "no-system-python",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running the machine's own python/python3 — use infra/deps' python kind (uv-managed CPython).",
    },
    schema: [],
    messages: {
      systemPython:
        "This runs the machine's own Python. On macOS that is an xcode-select shim which pops the " +
        '"install the command line developer tools" dialog (under an unknown name like `python`, or ' +
        "without the tools), and elsewhere it is whatever Python happens to be installed. Declare a " +
        "`python/` uv project and run it with pythonEnv + runPython " +
        "(@plugins/infra/plugins/deps/plugins/python/deps), or, for a test, link a uv-managed " +
        "interpreter (`uv python find` under uvEnv(), which allows managed Pythons only).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // An argv handed straight to a call: `spawnCaptured(["python3", "-m", …])`,
      // or a shell's `["sh", "-c", "python3 …"]`. A data array whose first entry
      // happens to be "python" (a language table) is not an argv.
      ArrayExpression(node) {
        const parent = node.parent;
        if (
          (parent.type !== "CallExpression" &&
            parent.type !== "NewExpression") ||
          !parent.arguments.includes(node)
        ) {
          return;
        }
        const words = node.elements.map((e) =>
          e === null || e.type === "SpreadElement" ? null : stringValue(e),
        );
        const head = words[0];
        if (head !== null && head !== undefined && PYTHON_COMMAND.test(head)) {
          context.report({
            node: node.elements[0]!,
            messageId: "systemPython",
          });
          return;
        }
        const script = words.findIndex(
          (_, i) => i > 0 && words[i - 1] === "-c",
        );
        const text = script === -1 ? null : words[script];
        if (text !== null && text !== undefined && PYTHON_SCRIPT.test(text)) {
          context.report({
            node: node.elements[script]!,
            messageId: "systemPython",
          });
        }
      },
      // A shell script or shebang: `exec python3 "$@"`, `#!/usr/bin/env python3`.
      Literal(node) {
        if (
          typeof node.value === "string" &&
          PYTHON_IN_SHELL.test(node.value)
        ) {
          context.report({ node, messageId: "systemPython" });
        }
      },
      TemplateLiteral(node) {
        const text = stringValue(node);
        if (text !== null && PYTHON_IN_SHELL.test(text)) {
          context.report({ node, messageId: "systemPython" });
        }
      },
    };
  },
});
