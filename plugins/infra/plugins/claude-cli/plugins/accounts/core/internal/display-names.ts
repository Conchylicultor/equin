import type { ClaudeAccounts } from "./accounts";

/**
 * `accounts` with every added account's name replaced by `standIn`: the
 * active account (the one every surface shows) bears it plain, the others are
 * numbered from 2 in list order; unchanged when `standIn` is empty.
 */
export function withStandInNames(
  accounts: ClaudeAccounts,
  standIn: string,
): ClaudeAccounts {
  if (standIn === "") return accounts;
  const lead =
    accounts.accounts.find((a) => a.id === accounts.active) ??
    accounts.accounts[0];
  let n = 1;
  return {
    ...accounts,
    accounts: accounts.accounts.map((a) => ({
      ...a,
      name: a === lead ? standIn : `${standIn} ${++n}`,
    })),
  };
}
