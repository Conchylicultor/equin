import {
  mintExecContext,
  type ExecContext,
} from "../../core/internal/exec-context";

/**
 * Minted by a `./equin` CLI command — a process of its own.
 *
 * Its host admission is loaded on first use, through a deferred relative
 * import: this file is re-exported by the `cli` barrel, which loads on EVERY
 * `./equin` invocation and so may reach no `server` barrel statically
 * (`cli:command-declarations-light`).
 */
export function cliExecContext(): ExecContext {
  return mintExecContext("cli", async (fn) => {
    const { admitBackground } = await import("../../server/internal/admit");
    return admitBackground(fn);
  });
}
