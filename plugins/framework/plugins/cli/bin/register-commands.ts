import type { Command } from "commander";
import type { CliCommand } from "../core";
import { disarmOrphanGuard } from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";
import {
  isHandoffOp,
  type HandoffOp,
} from "@plugins/framework/plugins/cli/plugins/foreground-handoff/core";
import { runHandedOff } from "@plugins/framework/plugins/cli/plugins/foreground-handoff/cli";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * The ONE translation of a declared {@link CliCommand} into commander calls.
 *
 * Everything a plugin can say about a command is data (`core/internal/command.ts`)
 * precisely so this file can be the only importer of commander outside the
 * bootstrap. That is not tidiness: `commander` is a workspace-local dependency
 * of the CLI plugin, so a contributing plugin's `cli/index.ts` could not import
 * it even if the shape allowed. The closed declaration and the single mapper are
 * two halves of one decision.
 *
 * The commander surface used here is the whole surface the framework's own
 * commands ever used: `command`, `description`, `argument`, `option`,
 * `requiredOption`, `action`, plus `enablePositionalOptions` /
 * `passThroughOptions` for the one command that forwards its tail. If a command
 * genuinely needs more, the declaration gains a field and this function gains a
 * line — a passthrough (`configure(cmd)`) would hand commander back to
 * contributors and re-open the dependency this design closes.
 */
export function registerCommands(
  program: Command,
  commands: readonly CliCommand[],
): void {
  for (const spec of commands) attach(program, spec, true);
}

/**
 * The foreground deadline an agent's guard exported into this call, when this
 * command is an op that hands off at one (`foreground-handoff`). Absent for a
 * human at a terminal, a background call, and the op the hand-off detached —
 * all of which run the command in place.
 */
function handoffOf(
  spec: CliCommand,
  topLevel: boolean,
): { op: HandoffOp; deadline: number } | null {
  if (!topLevel || !isHandoffOp(spec.name)) return null;
  const raw = readEnv("FOREGROUND_DEADLINE");
  if (raw === undefined) return null;
  const deadline = Number(raw);
  if (!Number.isFinite(deadline))
    throw new Error(
      `The foreground deadline is not an epoch-ms instant: ${JSON.stringify(raw)}.`,
    );
  return { op: spec.name, deadline };
}

function attach(parent: Command, spec: CliCommand, topLevel = false): void {
  const cmd = parent.command(spec.name).description(spec.description);

  // A group only routes. The declaration's leaf/group union makes "both" a type
  // error, and `isCliCommand` rejects it at the registry boundary, so this
  // branch needs no guard against a group that also declares `run`.
  if (spec.subcommands !== undefined) {
    for (const sub of spec.subcommands) attach(cmd, sub);
    return;
  }

  // `name` carries commander's own required/optional/variadic syntax
  // (`<x>` / `[x]` / `[x...]`), so there is nothing to translate.
  for (const arg of spec.arguments ?? []) {
    cmd.argument(arg.name, arg.description, arg.defaultValue);
  }

  // `flags` likewise carries commander's syntax, negatable `--no-x` included.
  for (const opt of spec.options ?? []) {
    if (opt.required === true) {
      cmd.requiredOption(opt.flags, opt.description, opt.defaultValue);
    } else {
      cmd.option(opt.flags, opt.description, opt.defaultValue);
    }
  }

  // Hand this command's tail to whatever it forwards to. `passThroughOptions`
  // stops option parsing at the first operand, so a flag meant for the payload
  // reaches it verbatim — `--help` included — with no `--` separator to
  // remember. Commander requires the enclosing command to have positional
  // options enabled, which is why the parent is configured from here rather
  // than once in `bin/cli.ts`: the requirement belongs to the command that has
  // it, not to the program, and the program declares no options for it to
  // reorder.
  if (spec.passthroughArgs === true) {
    parent.enablePositionalOptions();
    cmd.passThroughOptions();
  }

  const run = spec.run;
  if (run === undefined) {
    // Neither `run` nor `subcommands`. Unreachable through `defineCliCommand`
    // (the union has no such arm) and rejected by `isCliCommand`, so reaching
    // here means a third construction path exists that neither guards — say so
    // rather than registering a command that would silently do nothing.
    throw new Error(
      `CLI command "${spec.name}" declares neither run() nor subcommands, so it can never do anything. ` +
        `Declare it with defineCliCommand(), which makes this shape unspellable.`,
    );
  }

  cmd.action(async (...argv: unknown[]) => {
    // The command has been resolved, which is the earliest point at which
    // "is this one of the few commands meant to outlive its shell" is knowable.
    if (spec.detachable === true) disarmOrphanGuard();

    // Commander passes (...declaredArgs, options, Command). Dropping the
    // trailing Command is what makes `CliAction` the real call shape, so an
    // implementation never reaches around its own declaration into commander.
    const args = argv.slice(0, -1);

    // An agent's foreground call: run as a detached op that hands itself off
    // before the call's limit, instead of in place where the limit would kill it.
    const handoff = handoffOf(spec, topLevel);
    if (handoff !== null) await runHandedOff(handoff.op, handoff.deadline);

    // The import that the whole declaration/implementation split exists for:
    // this is where a command's body — and its npm dependencies, and the plugin
    // barrels it reaches — is loaded, i.e. only once this command is the one
    // actually running.
    const { default: action } = await run();
    await action(...args);
  });
}
