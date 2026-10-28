import {
  deleteSecret,
  getSecret,
  setSecret,
} from "@plugins/infra/plugins/secrets/server";
import {
  claudeCredentialKind,
  SYSTEM_ACCOUNT_ID,
  type ClaudeCredential,
} from "../../core";

// Each added account's credential (a plan token or an API key), in the
// encrypted secrets store (namespace `claude-accounts`, keyed by account id) —
// never in the accounts file.

const TOKENS_NAMESPACE = "claude-accounts";

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
 * The credential an agent on `id` signs in with, its kind derived from the
 * secret itself: `null` for the system account (Claude Code's own login). An
 * added account whose secret is gone throws — an agent must never fall back to
 * another account silently.
 */
export async function claudeAccountCredential(
  id: string,
): Promise<ClaudeCredential | null> {
  if (id === SYSTEM_ACCOUNT_ID) return null;
  const secret = await getSecret({ namespace: TOKENS_NAMESPACE, key: id });
  if (secret === undefined)
    throw new Error(
      `The credential of Claude account "${id}" is missing from the secrets store — remove the account and add it again`,
    );
  return { kind: claudeCredentialKind(secret), secret };
}
