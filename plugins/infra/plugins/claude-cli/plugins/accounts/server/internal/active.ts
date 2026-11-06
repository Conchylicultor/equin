import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/**
 * Which Claude account new sessions run on — an agent's launch, a one-shot
 * generation. The choice lives in the machine-wide accounts file, so the
 * desktop's provider (`accounts#machine`) reads it there.
 */
export interface ActiveClaudeAccountImpl {
  /** The active account's id (`SYSTEM_ACCOUNT_ID` or a token account's). */
  id(): Promise<string>;
}

export const ActiveClaudeAccount = defineHostService<ActiveClaudeAccountImpl>(
  "claude-accounts.active",
);

/** The account new sessions run on, read now. */
export function activeClaudeAccountId(): Promise<string> {
  return ActiveClaudeAccount.get().id();
}
