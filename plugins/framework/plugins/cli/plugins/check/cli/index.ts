import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import { CHECK_SCOPES } from "@plugins/framework/plugins/tooling/core";

/**
 * The repo's verdict, as a command. `build` and `push` do not re-implement it —
 * they spawn this same command in a subprocess, so the `checks ✓` all three
 * print is one claim rather than three implementations that could drift.
 *
 * The declaration exercises the two commander shapes nothing else in the CLI
 * needed: a VARIADIC positional (`[checks...]`, which commander hands the action
 * as a `string[]` — empty, never undefined, when no id is typed) and a NEGATABLE
 * flag (`--no-cache`, which commander binds to a `cache` property that is `true`
 * by default and `false` only when the flag is passed — hence the action's
 * `opts.cache === false` rather than a truthiness test).
 *
 * `--scope`'s help interpolates {@link CHECK_SCOPES} so the listed scopes cannot
 * fall behind the set the action validates against. That import is a `core`
 * barrel with one type-only edge of its own, so this declaration still reaches
 * no npm package and no `web`/`server` barrel — `cli:command-declarations-light`
 * holds.
 *
 * `--jobs` deliberately does NOT do the same with `hostCpuCeiling()`. Its
 * default is not a constant this file could interpolate: it is
 * `min(selected.length, cores)`, and how many checks a run selects is only known
 * after the scope / always-run / id filters have run inside `runChecks`. So the
 * default lives where it is computed and is DESCRIBED here in prose — which is
 * also what the light check's own hint prescribes for an option default that
 * needs a real value.
 */
export default defineCliCommand<
  [string[]],
  {
    list?: boolean;
    status?: boolean;
    cache?: boolean;
    scope?: string;
    alwaysRun?: boolean;
    runId?: string;
    jobs?: string;
  }
>({
  name: "check",
  description: "Run repo validation checks",
  arguments: [
    { name: "[checks...]", description: "Check IDs to run (default: all)" },
  ],
  options: [
    { flags: "--list", description: "List available checks and exit" },
    {
      flags: "--status",
      description:
        "Print in-flight check runs from the durable progress log and exit. A pure read: " +
        "acquires no host grant and runs no check, so it answers from a second shell while " +
        "a run is wedged — naming the check(s) that started and never settled.",
    },
    {
      flags: "--no-cache",
      description: "Bypass the tree-hash check-result cache",
    },
    {
      flags: "--scope <scopes>",
      description:
        `Run only checks of these scopes — one, or a comma-separated list, of ` +
        `${CHECK_SCOPES.join(" | ")}; default: every scope. ` +
        "`tree` = the verdict is a function of the tree content, i.e. of what a push carries; " +
        "`deploy` = it verifies the local gitignored dist/artifact store `build` produces; " +
        "`host` = it is about this MACHINE — the shared data root and other host-global state " +
        "no single worktree owns, which another live checkout may have created. " +
        "`--scope tree` reproduces the pass `./equin push` runs, and " +
        "`--scope tree,deploy` the pass `./equin build` runs.",
    },
    {
      flags: "--always-run",
      description:
        "Run only the checks flagged `alwaysRun` — the cheap structural subset a " +
        "`build --skip-checks` still proves. By PROPERTY, never by id, so deleting the " +
        "last such check fails loudly instead of quietly proving less. Composes with " +
        "--scope (AND).",
    },
    {
      flags: "--jobs <n>",
      description:
        "How many checks run at once. Default: unbounded — every selected check starts at " +
        "once, so an ordinary run is no slower than it ever was. `--jobs 1` runs the suite " +
        "serially, which is the only way to read a check's true cost: unbounded, a check's " +
        "recorded duration is mostly the wave's own length (the suite costs 601s serially " +
        "and reports 13817s unbounded), and even a merely narrower run reorders the table. " +
        "Also settable as " +
        "SINGULARITY_CHECK_JOBS, which is what reaches the check pass `build` and `push` " +
        "spawn (they inherit the environment; nothing threads a flag through). The flag " +
        "wins over the env var; a value that is not a positive integer fails loudly rather " +
        "than falling back to the default.",
    },
    {
      flags: "--run-id <id>",
      description:
        "Adopt the calling op's run id, so this run's own check transcript, its progress records " +
        "and the console all name the parent op. Only valid for a nested check (one that " +
        "inherited a parent's host grant) — a top-level check must mint its own.",
    },
  ],
  run: () => import("./run"),
});
