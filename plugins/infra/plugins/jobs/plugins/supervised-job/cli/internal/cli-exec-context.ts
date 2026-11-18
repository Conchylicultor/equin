import type { installGrantHooks } from "@plugins/installer/plugins/waits/cli";
import {
  mintExecContext,
  type ExecContext,
} from "../../core/internal/exec-context";

/**
 * The install-wait reporter's barrel, loaded at the admission through a
 * computed specifier: it reaches the op log's server barrel, which a `cli`
 * declaration loaded on every invocation may not (`cli:command-declarations-light`).
 */
const INSTALL_WAITS_MODULE = "@plugins/installer/plugins/waits/cli";
interface InstallWaitsModule {
  installGrantHooks: typeof installGrantHooks;
}

/**
 * Minted by a `./equin` CLI command — a process of its own. Its admission
 * is in the caller's lane (`admitForCaller`): interactive when a person runs
 * it on the main checkout, background otherwise, an ancestor op's when nested.
 *
 * Its host admission is loaded on first use, through a deferred relative
 * import: this file is re-exported by the `cli` barrel, which loads on EVERY
 * `./equin` invocation and so may reach no `server` barrel statically
 * (`cli:command-declarations-light`).
 *
 * Run as an install step (`./equin start` under install.sh), a queue for the
 * machine's build slot is reported to the install as a wait naming who holds
 * it (installer/waits) — the 2026-11-17 VM installs sat 22 minutes in a
 * dependency build's admission with nothing said.
 */
export function cliExecContext(): ExecContext {
  return mintExecContext("cli", async (fn) => {
    const waitsModule: string = INSTALL_WAITS_MODULE;
    const [{ admitForCaller }, waits] = await Promise.all([
      import("../../server/internal/admit"),
      import(waitsModule) as Promise<InstallWaitsModule>,
    ]);
    return admitForCaller(fn, waits.installGrantHooks());
  });
}
