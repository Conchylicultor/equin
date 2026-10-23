import { defineGuard } from "../define-guard";
import { MODULE_EXTENSION } from "../module-extension";
import { findCall } from "../parse-shell";
import type { BashInput } from "../types";

/**
 * `bun` flags whose value is the NEXT token, and whose value can plausibly be a
 * module path — the only ones that matter here, because the whole question this
 * scan answers is "is the first operand a module?".
 *
 * Missing an entry can only over-block (a flag's `.ts` value is mistaken for the
 * script). Adding one wrongly UNDER-blocks — a real script token gets skipped as
 * some flag's value — so the set stays deliberately small rather than mirroring
 * `bun --help` wholesale.
 */
const VALUE_TAKING_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--preload",
  "-c",
  "--config",
  "--env-file",
  "--tsconfig-override",
  "-d",
  "--define",
  "-l",
  "--loader",
  "--cwd",
  "-F",
  "--filter",
]);

/**
 * The module a `bun` call would EXECUTE, or undefined when the call runs
 * something else.
 *
 * The discriminator is the token, not the presence of `run`: `bun run <name>`
 * resolves a package.json script — a *bin*, which has no module-resolution
 * problem — while `bun run <file>.ts` and bare `bun <file>.ts` both load a
 * module. So the scan walks past flags and past an optional leading `run`, then
 * asks one question of the first operand it reaches. Every other subcommand
 * (`install`, `test`, `add`, `build`, `x`, …) falls out for free: none of them
 * is spelled as a module path.
 */
function executedModule(args: string[]): string | undefined {
  let sawRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-") && arg.length > 1) {
      // `--flag=value` carries its value inline; only the separate form eats the
      // next token.
      if (!arg.includes("=") && VALUE_TAKING_FLAGS.has(arg)) i++;
      continue;
    }
    if (arg === "run" && !sawRun) {
      sawRun = true;
      continue;
    }
    return MODULE_EXTENSION.test(arg) ? arg : undefined;
  }
  return undefined;
}

export const bunScriptGuard = defineGuard<BashInput>({
  name: "bun-script",
  matcher: "Bash",
  bypassToken: ".allow-bun-script",
  check(input) {
    const cmd = input.command;
    if (!cmd) return null;
    const offending = findCall(
      cmd,
      (c) => c.name === "bun" && executedModule(c.args) !== undefined,
    );
    if (!offending) return null;
    const script = executedModule(offending.args)!;
    return {
      blocked: `\`bun ${script}\` runs the script against whichever checkout's \`node_modules\` it happens to find first.`,
      why: "Module resolution walks UP the directory tree, so a worktree without its own `node_modules` silently uses the MAIN checkout's installed tree — or, if that is mid-install, whatever the registry's `latest` is today. Which dependency versions the script gets depends on timing, not on this branch's `bun.lock`. That is how an e2e script came to launch a Playwright the lockfile never chose, demanding a chromium revision nothing had provisioned.",
      hint: `Use \`./equin run ${script} [args…]\` — it installs this worktree's own dependencies from its own lock (and provisions their binaries) first, then runs the script. \`bun run <script-name>\`, \`bun install\`, \`bun test\` and \`bunx\` are untouched: they resolve a bin or a subcommand, not a module.`,
    };
  },
});
