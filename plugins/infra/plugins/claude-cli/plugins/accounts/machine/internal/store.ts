import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { rename, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  claudeCredentialKind,
  ClaudeAccountsSchema,
  NO_CLAUDE_ACCOUNTS,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccount,
  type ClaudeAccounts,
} from "../../core";
import { claudeAccountsDir } from "../../data-dirs";
import {
  deleteClaudeAccountCredential,
  saveClaudeAccountCredential,
  type ActiveClaudeAccountImpl,
} from "../../server";

// The accounts file (the credentials are the server half's, in the secrets store). Every write
// replaces the file whole through a rename, so a reader (another worktree's
// launch, the live value's watch) never sees half of it.

const ACCOUNTS_FILE = "accounts.json";

function claudeAccountsPath(): AppPath {
  return claudeAccountsDir.file(ACCOUNTS_FILE);
}

/** The accounts as saved; none added yet → the system account alone. */
export async function readClaudeAccounts(): Promise<ClaudeAccounts> {
  let text: string;
  try {
    text = await readFile(claudeAccountsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return NO_CLAUDE_ACCOUNTS;
    throw err;
  }
  return ClaudeAccountsSchema.parse(JSON.parse(text));
}

async function writeClaudeAccounts(state: ClaudeAccounts): Promise<void> {
  claudeAccountsDir.ensure();
  const path = claudeAccountsPath();
  const tmp = asAppPath(`${path}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

// Every change is read-modify-write of one file: serialized, so two callers
// (the endpoints, an agent launch switching account) never interleave and lose
// one another's change.
const accountsMutex = createKeyedMutex();
const changeAccounts = <T>(fn: () => Promise<T>): Promise<T> =>
  accountsMutex.run(ACCOUNTS_FILE, fn);

function assertKnown(state: ClaudeAccounts, id: string): void {
  if (id !== SYSTEM_ACCOUNT_ID && !state.accounts.some((a) => a.id === id))
    throw new Error(`No Claude account "${id}"`);
}

export async function addClaudeAccountWithCredential(
  name: string,
  credential: string,
): Promise<ClaudeAccount> {
  const account: ClaudeAccount = {
    id: `acct-${crypto.randomUUID().slice(0, 8)}`,
    name,
    addedAt: Date.now(),
    kind: claudeCredentialKind(credential),
  };
  // The credential first: an account in the list always has one.
  await saveClaudeAccountCredential(account.id, credential);
  await changeAccounts(async () => {
    const state = await readClaudeAccounts();
    await writeClaudeAccounts({
      ...state,
      accounts: [...state.accounts, account],
    });
  });
  return account;
}

export async function removeClaudeAccountById(id: string): Promise<void> {
  if (id === SYSTEM_ACCOUNT_ID)
    throw new Error("The computer's own Claude Code account can't be removed");
  await changeAccounts(async () => {
    const state = await readClaudeAccounts();
    assertKnown(state, id);
    await writeClaudeAccounts({
      ...state,
      accounts: state.accounts.filter((a) => a.id !== id),
      active: state.active === id ? SYSTEM_ACCOUNT_ID : state.active,
    });
  });
  await deleteClaudeAccountCredential(id);
}

export function selectClaudeAccountById(id: string): Promise<void> {
  return changeAccounts(async () => {
    const state = await readClaudeAccounts();
    assertKnown(state, id);
    if (state.active !== id)
      await writeClaudeAccounts({ ...state, active: id });
  });
}

export function setClaudeAccountsAutoSwitch(enabled: boolean): Promise<void> {
  return changeAccounts(async () => {
    const state = await readClaudeAccounts();
    if (state.autoSwitch !== enabled)
      await writeClaudeAccounts({ ...state, autoSwitch: enabled });
  });
}

/** The ActiveClaudeAccount host service on the desktop: the file's choice, read now. */
export const activeAccountFromFile: ActiveClaudeAccountImpl = {
  id: async () => (await readClaudeAccounts()).active,
};
