import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  ClaudeAccountsSchema,
  NO_CLAUDE_ACCOUNTS,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccount,
  type ClaudeAccounts,
} from "../../core";
import { claudeAccountsDir } from "../../data-dirs";
import { deleteClaudeAccountToken, saveClaudeAccountToken } from "../../server";

// The accounts file (the tokens are the server half's, in the secrets store). Every write
// replaces the file whole through a rename, so a reader (another worktree's
// launch, the live value's watch) never sees half of it.

const ACCOUNTS_FILE = "accounts.json";

function claudeAccountsPath(): string {
  return claudeAccountsDir.file(ACCOUNTS_FILE);
}

/** The accounts as saved; none added yet → the system account alone. */
export function readClaudeAccounts(): ClaudeAccounts {
  let text: string;
  try {
    text = readFileSync(claudeAccountsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return NO_CLAUDE_ACCOUNTS;
    throw err;
  }
  return ClaudeAccountsSchema.parse(JSON.parse(text));
}

function writeClaudeAccounts(state: ClaudeAccounts): void {
  claudeAccountsDir.ensure();
  const path = claudeAccountsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

function assertKnown(state: ClaudeAccounts, id: string): void {
  if (id !== SYSTEM_ACCOUNT_ID && !state.accounts.some((a) => a.id === id))
    throw new Error(`No Claude account "${id}"`);
}

export async function addClaudeAccountWithToken(
  name: string,
  token: string,
): Promise<ClaudeAccount> {
  const account: ClaudeAccount = {
    id: `acct-${crypto.randomUUID().slice(0, 8)}`,
    name,
    addedAt: Date.now(),
  };
  // The token first: an account in the list always has one.
  await saveClaudeAccountToken(account.id, token);
  const state = readClaudeAccounts();
  writeClaudeAccounts({ ...state, accounts: [...state.accounts, account] });
  return account;
}

export async function removeClaudeAccountById(id: string): Promise<void> {
  if (id === SYSTEM_ACCOUNT_ID)
    throw new Error("The computer's own Claude Code account can't be removed");
  const state = readClaudeAccounts();
  assertKnown(state, id);
  writeClaudeAccounts({
    ...state,
    accounts: state.accounts.filter((a) => a.id !== id),
    active: state.active === id ? SYSTEM_ACCOUNT_ID : state.active,
  });
  await deleteClaudeAccountToken(id);
}

export function selectClaudeAccountById(id: string): void {
  const state = readClaudeAccounts();
  assertKnown(state, id);
  if (state.active !== id) writeClaudeAccounts({ ...state, active: id });
}

export function setClaudeAccountsAutoSwitch(enabled: boolean): void {
  const state = readClaudeAccounts();
  if (state.autoSwitch !== enabled)
    writeClaudeAccounts({ ...state, autoSwitch: enabled });
}
