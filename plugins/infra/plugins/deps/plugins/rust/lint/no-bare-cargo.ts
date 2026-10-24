import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/** A command word naming cargo: `cargo`, `~/.cargo/bin/cargo`. */
const CARGO_COMMAND = /^(?:\S*\/)?cargo$/;

/**
 * A shell string that runs cargo with a subcommand: after a command separator
 * or `exec`. Deliberately not "starts with cargo": prose such as `cargo build
 * failed` is not a command.
 */
const CARGO_IN_SHELL = /(?:[;&|(]\s*|\bexec\s+)cargo[ \t]+[a-z]/;

/** The script of `sh -c "<script>"` starting with cargo: `cargo build`. */
const CARGO_SCRIPT = /^\s*cargo(?=\s|$)/;

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
 * Bans spawning cargo outside infra/deps' rust kind. A bare `cargo` runs
 * whatever is first on the caller's PATH (rustup's default toolchain rather
 * than the release `mise.lock` pins), builds into the crate's own `target/`
 * (cold in every worktree), and outside the deps cache nothing records what
 * was built from what. The kind builds a `rust/` crate (`cargoBuild`) and spells
 * every other cargo command (`cargoCommand`) under the mise-pinned toolchain.
 */
export default createRule({
  name: "no-bare-cargo",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning cargo directly — build a rust/ crate with infra/deps' rust kind (cargoBuild), or spell the command with cargoCommand.",
    },
    schema: [],
    messages: {
      bareCargo:
        "This spawns cargo directly: it runs whatever cargo is first on PATH (not the toolchain " +
        "mise.lock pins) and compiles cold into the crate's own target/. Declare the crate as a " +
        "dependency with cargoBuild({ crate, bin }) and run cargoBinary(ready), or — for any other " +
        "cargo command — take its argv and env from cargoCommand([...]) " +
        "(@plugins/infra/plugins/deps/plugins/rust/deps).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // An argv handed straight to a call: `spawnCaptured(["cargo", "build", …])`,
      // or a shell's `["sh", "-c", "cargo build"]`.
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
        if (head !== null && head !== undefined && CARGO_COMMAND.test(head)) {
          context.report({ node: node.elements[0]!, messageId: "bareCargo" });
          return;
        }
        const script = words.findIndex(
          (_, i) => i > 0 && words[i - 1] === "-c",
        );
        const text = script === -1 ? null : words[script];
        if (text !== null && text !== undefined && CARGO_SCRIPT.test(text)) {
          context.report({
            node: node.elements[script]!,
            messageId: "bareCargo",
          });
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && CARGO_IN_SHELL.test(node.value)) {
          context.report({ node, messageId: "bareCargo" });
        }
      },
      TemplateLiteral(node) {
        const text = stringValue(node);
        if (text !== null && CARGO_IN_SHELL.test(text)) {
          context.report({ node, messageId: "bareCargo" });
        }
      },
    };
  },
});
