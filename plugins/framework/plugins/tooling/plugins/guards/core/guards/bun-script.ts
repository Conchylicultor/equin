import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { rewriteCalls } from "../call-splice";
import { defineGuard } from "../define-guard";
import { MODULE_EXTENSION } from "../module-extension";
import { classifyRepo } from "../git-target";
import { findCall, type ShellCall } from "../parse-shell";
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

/**
 * Whether the module `call` executes sits in a equin checkout — the only
 * place resolution can walk up into a checkout's `node_modules`, and the only
 * place `./equin run` (the fix the hint names) exists. A script in a scratch
 * workspace or any other directory outside a checkout is left alone.
 */
function runsInCheckout(call: ShellCall, cwd: string): boolean {
  const script = executedModule(call.args);
  if (script === undefined) return false;
  const path = script.startsWith("/") ? script : `${call.cwd || cwd}/${script}`;
  return classifyRepo(path).kind === "equin";
}

/**
 * Where the script operand sits in `args` when `bun [run] <script>` is ALL the
 * call says before it — `undefined` when a bun flag precedes it (`--cpu-prof`,
 * `--bun`, `--cwd`): `./equin run` forwards nothing to bun itself, so those
 * calls have no equivalent to rewrite to.
 */
function bareScriptIndex(args: string[]): number | undefined {
  const at = args[0] === "run" ? 1 : 0;
  const script = args[at];
  return script !== undefined && MODULE_EXTENSION.test(script) ? at : undefined;
}

/**
 * Whether `./equin run` would run this call's script exactly as `bun` would:
 * no bun flags, and the call already runs AT the root of the checkout holding
 * the script. `./equin run` cd's to that root and resolves the script — and
 * the script then resolves its own relative arguments — from there, so from
 * any other directory the same words would name other files.
 */
function rewritable(call: ShellCall): boolean {
  const at = bareScriptIndex(call.args);
  if (at === undefined || !call.cwd) return false;
  const script = call.args[at]!;
  const path = script.startsWith("/") ? script : `${call.cwd}/${script}`;
  const repo = classifyRepo(path);
  return repo.kind === "equin" && repo.root === call.cwd;
}

export const bunScriptGuard = defineGuard<BashInput>({
  name: "bun-script",
  matcher: "Bash",
  bypassToken: ".allow-bun-script",
  check(input, ctx) {
    const cmd = input.command;
    if (!cmd) return null;
    const offending = findCall(
      cmd,
      (c) => c.name === "bun" && runsInCheckout(c, ctx.cwd),
      ctx.cwd,
    );
    if (!offending) return null;
    const rewritten = rewriteCalls(
      cmd,
      ctx.cwd,
      (c) => c.name === "bun" && runsInCheckout(c, ctx.cwd),
      (call, words) => {
        if (!rewritable(call)) return null;
        const script = words.args[bareScriptIndex(call.args)!]!;
        return [
          {
            from: words.name.start,
            to: script.start,
            text: `./${CLI_NAME} run `,
          },
        ];
      },
    );
    if (rewritten !== null)
      return {
        rewrite: { command: rewritten },
        note: `Your bare \`bun <script>\` was rewritten to \`./${CLI_NAME} run <script>\` (same script, same arguments, same directory) and ran as:\n  ${rewritten}\nBare \`bun\` resolves the script's dependencies by walking UP into whichever checkout's \`node_modules\` it finds first; \`./${CLI_NAME} run\` installs this checkout's own lock first. Type \`./${CLI_NAME} run\` yourself next time.`,
      };
    const script = executedModule(offending.args)!;
    return {
      blocked: `\`bun ${script}\` runs the script against whichever checkout's \`node_modules\` it happens to find first. A bare \`bun <script>\` run from the checkout root is rewritten for you; this one could not be (a bun flag before the script, or a working directory other than the checkout root, where \`./${CLI_NAME} run\` would resolve the paths differently).`,
      why: "Module resolution walks UP the directory tree, so a worktree without its own `node_modules` silently uses the MAIN checkout's installed tree — or, if that is mid-install, whatever the registry's `latest` is today. Which dependency versions the script gets depends on timing, not on this branch's `bun.lock`. That is how an e2e script came to launch a Playwright the lockfile never chose, demanding a chromium revision nothing had provisioned.",
      hint: `Use \`./equin run ${script} [args…]\` — it installs this worktree's own dependencies from its own lock (and provisions their binaries) first, then runs the script. \`bun run <script-name>\`, \`bun install\`, \`bun test\` and \`bunx\` are untouched: they resolve a bin or a subcommand, not a module.`,
    };
  },
});
