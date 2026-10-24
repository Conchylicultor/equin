/**
 * The CLI command declaration — what a plugin's `cli/index.ts` default-exports,
 * and the whole of what `./equin` knows about a command before it runs it.
 *
 * TWO PROPERTIES SHAPE EVERY TYPE HERE.
 *
 * 1. THE DECLARATION IS REACHED ON EVERY INVOCATION; THE IMPLEMENTATION IS NOT.
 *    Commander needs a command's name, flags and help text before it can parse
 *    argv, so every plugin's declaration loads on every single `./equin`
 *    call — including the hot `build` path. Its implementation must not: that is
 *    why {@link CliCommandSpec.run} hands back the *module* rather than the
 *    function, so the body is behind a dynamic `import()` that only executes
 *    once commander has routed to this command. Enforced by
 *    `cli:command-declarations-light`, which measures each `cli/index.ts`'s
 *    static closure and fails it for reaching an npm package or a `web`/`server`
 *    barrel.
 *
 * 2. THE SHAPE IS CLOSED, NOT A COMMANDER PASSTHROUGH. Across all of the
 *    framework's own commands the entire commander surface in use is
 *    `command` / `description` / `argument` / `option` / `requiredOption` /
 *    `action`, plus `enablePositionalOptions` / `passThroughOptions` behind
 *    {@link CliLeafSpec.passthroughArgs}. Modelling exactly that — rather than
 *    exposing a `configure(cmd: Command)` escape hatch — is what lets `core/`
 *    stay free of commander, which in turn is what lets a contributing plugin
 *    declare a command at all: `commander` is a workspace-local dependency of
 *    the CLI plugin and would not even resolve from another workspace package.
 *    A contributor cannot reach for a commander feature the mapper does not
 *    model, because they cannot reach commander.
 *
 * `bin/register-commands.ts` is the sole translation of these types into
 * commander calls.
 */

/**
 * One positional argument, in commander's own argument syntax so the required /
 * optional / variadic distinction has exactly one spelling:
 * `"<name>"` required, `"[name]"` optional, `"[name...]"` variadic.
 */
export interface CliArgumentSpec {
  readonly name: string;
  readonly description: string;
  readonly defaultValue?: string;
}

/**
 * One option, in commander's own flag syntax — `"--force"`, `"--name <name>"`,
 * `"--composition <name...>"`, or the negatable `"--no-cache"` form (which
 * commander binds to a `cache` property defaulting to true).
 *
 * `required: true` selects `requiredOption`, i.e. commander refuses the
 * invocation when the flag is absent, rather than the action discovering it.
 */
export interface CliOptionSpec {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: string | boolean;
  readonly required?: boolean;
}

/**
 * A command's implementation, as commander calls it: the declared positional
 * arguments in order, then the parsed options object.
 *
 * Commander actually passes a trailing `Command` too; the mapper drops it, so
 * this type IS the call shape and an implementation never sees a commander
 * object. That is deliberate — a command body that reaches into its own
 * `Command` is reaching around the declaration.
 */
export type CliAction<A extends readonly unknown[], O> = (
  ...args: [...A, O]
) => Promise<void>;

/**
 * The erased action the mapper invokes. The mapper spreads whatever commander
 * parsed, and commander's parse is driven by the very `arguments`/`options` this
 * command declared — so the arity agreement is real, but it is established by
 * the declaration rather than visible to the type system at the call site.
 */
type ErasedCliAction = (...args: readonly unknown[]) => Promise<void>;

/** A leaf command: it runs. */
interface CliLeafSpec<A extends readonly unknown[], O> {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly CliArgumentSpec[];
  readonly options?: readonly CliOptionSpec[];
  /**
   * Suppress the orphan guard for this command.
   *
   * `bin/index.ts` arms the guard for EVERY invocation, so a CLI process dies
   * with the shell that started it and can never sit on a host lock after its
   * invoker is gone. A handful of commands are legitimately run detached
   * (`nohup ./equin serve-app …` boots a runtime that is *supposed* to
   * outlive the shell); those declare this, and the mapper disarms the guard as
   * the command begins.
   *
   * Default off, because the safe answer is the default: a new command that
   * forgets to think about this gets guarded, not orphaned.
   */
  readonly detachable?: boolean;
  /**
   * Everything after the last declared positional argument belongs to the
   * COMMAND'S OWN payload, not to `./equin`.
   *
   * Commander's default is to claim any flag it recognizes and reject any it
   * does not, which is right for every command whose arguments are its own and
   * wrong for the one command that forwards them: `./equin run
   * script.ts --headed` would fail with `unknown option '--headed'`, and even
   * `--help` would print the CLI's help instead of the script's.
   *
   * The mapper turns this into commander's `passThroughOptions()`, which stops
   * option parsing at the first operand — so a forwarded flag is forwarded
   * verbatim and no `--` separator is needed. A flag placed BEFORE the first
   * operand is still parsed as this command's, and still rejected if unknown,
   * which is what keeps the command's own declared options meaningful.
   *
   * Only declare it on a command that genuinely hands its tail to something
   * else; on any other command it would turn a typo'd flag into a silently
   * ignored positional.
   */
  readonly passthroughArgs?: boolean;
  readonly run: () => Promise<{ default: CliAction<A, O> }>;
  readonly subcommands?: never;
}

/** A group: it only routes to subcommands (`deploy converge`, `db fork`). */
interface CliGroupSpec {
  readonly name: string;
  readonly description: string;
  readonly subcommands: readonly CliCommand[];
  readonly run?: never;
  readonly arguments?: never;
  readonly options?: never;
  readonly detachable?: never;
  readonly passthroughArgs?: never;
}

/**
 * A command is a leaf or a group, never both. The `never` arms make the wrong
 * shape a type error at the declaration site rather than a runtime check in the
 * mapper — there is no coherent meaning for a command that both runs and routes,
 * so it should not be spellable.
 */
export type CliCommandSpec<A extends readonly unknown[], O> =
  CliLeafSpec<A, O> | CliGroupSpec;

/**
 * A declared command with its argument/option types erased — what containers
 * hold (a group's `subcommands`, the registry, the mapper). The generics on
 * {@link CliCommandSpec} exist to check ONE declaration against ONE
 * implementation; past that boundary they have no consumer, and keeping them
 * would make a heterogeneous `subcommands` array unspellable.
 */
export interface CliCommand {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly CliArgumentSpec[];
  readonly options?: readonly CliOptionSpec[];
  readonly subcommands?: readonly CliCommand[];
  readonly detachable?: boolean;
  readonly passthroughArgs?: boolean;
  readonly run?: () => Promise<{ default: ErasedCliAction }>;
}

/**
 * Declare a command.
 *
 * `A` (positional argument types) and `O` (the parsed options object) can be
 * left to inference, in which case they are read off the implementation module's
 * default export and nothing is cross-checked. PIN THEM — `defineCliCommand<[string], { force?: boolean }>({…})`
 * — and the declaration becomes the contract: the implementation's default
 * export is then checked against it, so renaming a flag without touching the
 * body is a type error instead of an `undefined` at runtime.
 */
export function defineCliCommand<A extends readonly unknown[] = [], O = object>(
  spec: CliCommandSpec<A, O>,
): CliCommand {
  // The one cast in this file, at the one place erasure happens. `A`/`O` have
  // served their purpose (checking this spec's `run` against its module) and the
  // mapper below spreads commander's parse, whose arity is a function of the
  // very `arguments`/`options` declared here.
  return spec as unknown as CliCommand;
}

/**
 * Validate a value arriving from the registry, where it is `unknown` — a
 * contributed `cli/index.ts` is ordinary plugin code and its default export is
 * not type-checked against this module by anything but the contributor's own
 * `defineCliCommand` call.
 *
 * Checks the leaf/group exclusive-or too, because that is exactly the invariant
 * the type system enforced at the declaration site and therefore exactly what a
 * hand-rolled or mis-built export can violate.
 */
export function isCliCommand(value: unknown): value is CliCommand {
  if (typeof value !== "object" || value === null) return false;
  const c = value as CliCommand;
  if (typeof c.name !== "string" || c.name === "") return false;
  if (typeof c.description !== "string") return false;
  const isLeaf = typeof c.run === "function";
  const isGroup = Array.isArray(c.subcommands);
  if (isLeaf === isGroup) return false; // both, or neither
  if (isGroup) return c.subcommands!.every(isCliCommand);
  return true;
}
