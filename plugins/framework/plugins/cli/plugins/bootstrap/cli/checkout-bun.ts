import { refreshCheckoutBun } from "@plugins/packages/plugins/process-name/machine";

/**
 * Record the Bun this CLI runs on as the checkout's, so the next `./equin` runs
 * as `equin · <verb> · <checkout>` in Activity Monitor rather than `bun`
 * (packages/process-name). Call only on the Bun `mise.lock` picks — the script
 * trusts the record while it is newer than the lock. A filesystem refusing the
 * hardlink only leaves the name plain: nothing to report on every command.
 */
export function recordCheckoutBun(): void {
  refreshCheckoutBun(process.cwd(), process.execPath);
}
