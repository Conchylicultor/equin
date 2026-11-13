import { watchClaudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/machine";
import { noteActiveAccountChanged } from "../../server/internal/status";

let release: (() => void) | null = null;

/**
 * Follow the active Claude account: every rewrite of the accounts file (from
 * any backend) hands it to {@link noteActiveAccountChanged}, which wakes the
 * launches a signed-out computer held back once an account with its own
 * credential is made active. Records the current account first, so a switch
 * is measured from boot.
 */
export async function startActiveAccountWatch(): Promise<void> {
  await noteActiveAccountChanged();
  release = await watchClaudeAccounts(() => {
    // A file-watch callback cannot await; a failed read rejects loudly.
    void noteActiveAccountChanged();
  });
}

export function stopActiveAccountWatch(): void {
  release?.();
  release = null;
}
