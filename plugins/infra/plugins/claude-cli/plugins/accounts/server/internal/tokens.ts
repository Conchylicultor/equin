import {
  deleteSecret,
  getSecret,
  setSecret,
} from "@plugins/infra/plugins/secrets/server";
import { SYSTEM_ACCOUNT_ID } from "../../core";

// Each token account's token, in the encrypted secrets store (namespace
// `claude-accounts`, keyed by account id) — never in the accounts file.

const TOKENS_NAMESPACE = "claude-accounts";

export async function saveClaudeAccountToken(
  id: string,
  token: string,
): Promise<void> {
  await setSecret({ namespace: TOKENS_NAMESPACE, key: id }, token);
}

export async function deleteClaudeAccountToken(id: string): Promise<void> {
  await deleteSecret({ namespace: TOKENS_NAMESPACE, key: id });
}

/**
 * The token an agent on `id` signs in with: `null` for the system account
 * (Claude Code's own login). A token account whose secret is gone throws — an
 * agent must never fall back to another account silently.
 */
export async function claudeAccountToken(id: string): Promise<string | null> {
  if (id === SYSTEM_ACCOUNT_ID) return null;
  const token = await getSecret({ namespace: TOKENS_NAMESPACE, key: id });
  if (token === undefined)
    throw new Error(
      `The token of Claude account "${id}" is missing from the secrets store — remove the account and add it again`,
    );
  return token;
}
