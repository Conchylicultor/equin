import { program } from "commander";
import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import {
  CLI_NAME,
  isCliCommand,
  isCliEntryPresent,
  type CliCommand,
} from "../core";
import { cliEntries } from "../core/cli.generated";
import { registerCommands } from "./register-commands";
import { runCli } from "./run-cli";

/**
 * The CLI proper: the commander program, the plugin-contributed command
 * registry, and the parse. This IS what `./singularity <cmd>` runs, and it is
 * reached ONLY through `./index.ts`'s `await import("./cli")`.
 *
 * Why the split from `./index.ts` exists: this file's very first line imports
 * `commander`, an npm package. A static import is hoisted above every statement
 * in its module, so a module that wants to run `bun install` BEFORE the CLI
 * cannot also be the module that imports the CLI's dependencies — the resolution
 * would happen first, against the `node_modules` we were about to fix. Reaching
 * this file is therefore the *act* of asserting "`node_modules` is known good".
 * See that file's docblock for the whole contract.
 *
 * Commands are CONTRIBUTIONS, not a list here. A plugin drops a `cli/index.ts`
 * default-exporting `defineCliCommand(…)` and `./singularity build` regenerates
 * `../core/cli.generated.ts` from the filesystem; nothing in the framework CLI
 * names it. Each entry's loader pulls one plugin's declaration — data only, by
 * `cli:command-declarations-light` — and the command's IMPLEMENTATION stays
 * behind the declaration's own lazy `import()` until commander routes to it. So
 * `./singularity build` no longer pays to load every other command's body.
 */

program.name(CLI_NAME).description("Equin agent CLI");

// `strict`: a declaration that throws at load must not read as "that command
// does not exist" — `./singularity build` reporting "unknown command" would
// look like a typo rather than a broken tree.
//
// `isPresent`: an entry whose declaration file is GONE is the opposite case —
// the command really does not exist, and the registry line is stale. It must be
// skipped, not failed: this CLI is the only thing that regenerates the registry,
// so failing here would leave no command able to start to repair it (`build`
// and `push` included).
const repoRoot = repoRootOf(import.meta.path);
const contributed = await loadCollectedDir<CliCommand>(cliEntries, {
  isItem: isCliCommand,
  label: "cli command",
  strict: true,
  isPresent: (entry) => isCliEntryPresent(repoRoot, entry),
});

assertUniqueNames(contributed);

// Sorted by name so `--help` has a stable order that does not depend on where in
// the plugin tree a command happens to live (the registry is ordered by import
// path, which would reshuffle `--help` when a command moves).
registerCommands(
  program,
  [...contributed].sort((a, b) => a.name.localeCompare(b.name)),
);

await runCli(program);

/**
 * The repo root, from this file's own location rather than the cwd (the CLI can
 * be run from any directory). Throws if the file moved, rather than resolving
 * every declaration against the wrong directory and skipping them all as stale.
 */
function repoRootOf(selfPath: string): string {
  const suffix = "plugins/framework/plugins/cli/bin/cli.ts";
  if (!selfPath.endsWith(suffix)) {
    throw new Error(
      `bin/cli.ts is at ${selfPath}, not at <root>/${suffix} — update repoRootOf.`,
    );
  }
  return selfPath.slice(0, -suffix.length);
}

/**
 * Two plugins claiming one verb is a conflict with no correct resolution, and
 * the silent outcome is the dangerous one: commander would keep whichever
 * registered first and the other plugin's command would simply not be there.
 *
 * This is the BACKSTOP, not the enforcement. `cli:command-names-unique` is what
 * a human sees, and it says strictly more: it reads the registry, so it can name
 * the CLAIMING PLUGINS rather than just the verb, and it walks subcommand paths
 * (`deploy converge`) which this cannot — by the time `loadCollectedDir` has
 * returned, the items no longer carry which plugin they came from. What is left
 * here is the case the check cannot cover: a tree that changed since the last
 * `./singularity check`, where refusing to run beats running the wrong command.
 */
function assertUniqueNames(commands: readonly CliCommand[]): void {
  const seen = new Map<string, number>();
  for (const c of commands) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicated.length === 0) return;
  throw new Error(
    `${duplicated.length} CLI command name(s) are claimed by more than one plugin: ` +
      `${duplicated.join(", ")}. A verb belongs to exactly one plugin — rename one of them.`,
  );
}
