import {
  deleteSecret,
  getSecret,
  setSecret,
} from "@plugins/infra/plugins/secrets/server";
import { defineSecretNamespace } from "@plugins/infra/plugins/secrets/core";
import { API_KEY_PREFIXES, SYSTEM_ACCOUNT_ID } from "../../core";

// Each added account's API key, in the
// encrypted secrets store (namespace `claude-accounts`, keyed by account id) —
// never in the accounts file.

const TOKENS_NAMESPACE = defineSecretNamespace("claude-accounts", {
  scope: "machine",
});

export async function saveClaudeAccountCredential(
  id: string,
  token: string,
): Promise<void> {
  await setSecret({ namespace: TOKENS_NAMESPACE, key: id }, token);
}

export async function deleteClaudeAccountCredential(id: string): Promise<void> {
  await deleteSecret({ namespace: TOKENS_NAMESPACE, key: id });
}

/**
 * The API key an agent on `id` signs in with: `null` for the system account
 * (Claude Code's own login). An added account whose secret is gone throws — an
 * agent must never fall back to another account silently — and so does one
 * whose secret is not an API key: a plan token left from before added plan
 * accounts were removed is never used (`core/internal/accounts.ts`).
 */
export async function claudeAccountCredential(
  id: string,
): Promise<string | null> {
  if (id === SYSTEM_ACCOUNT_ID) return null;
  const secret = await getSecret({ namespace: TOKENS_NAMESPACE, key: id });
  if (secret === undefined)
    throw new Error(
      `The credential of Claude account "${id}" is missing from the secrets store — remove the account and add it again`,
    );
  if (!API_KEY_PREFIXES.some((p) => secret.startsWith(p)))
    throw new Error(
      `Claude account "${id}" holds a plan sign-in token, not an API key — equin runs plans only on the computer's own Claude Code login; remove the account`,
    );
  return secret;
}
