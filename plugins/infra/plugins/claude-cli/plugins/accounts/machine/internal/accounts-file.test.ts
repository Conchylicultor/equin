import { describe, expect, test } from "bun:test";
import { accountsFileOf, parseAccountsFile } from "./accounts-file";

const key = { id: "acct-key", name: "API credit", addedAt: 2 };

describe("parseAccountsFile", () => {
  test("a file written since reads back as written", () => {
    const state = { accounts: [key], active: "acct-key" };
    expect(parseAccountsFile(accountsFileOf(state))).toEqual({
      state,
      planAccounts: [],
    });
  });

  test("an older file's plan accounts are never run on", () => {
    const file = {
      accounts: [
        { id: "acct-plan", name: "Work", addedAt: 1, kind: "token" },
        { ...key, kind: "api-key" },
      ],
      active: "acct-key",
      autoSwitch: true,
    };
    expect(parseAccountsFile(file)).toEqual({
      state: { accounts: [key], active: "acct-key" },
      planAccounts: ["acct-plan"],
    });
  });

  test("an active plan account falls back to the computer's own login", () => {
    // Written before API keys existed: no kind, every account a plan token.
    const file = {
      accounts: [{ id: "acct-plan", name: "Work", addedAt: 1 }],
      active: "acct-plan",
    };
    expect(parseAccountsFile(file)).toEqual({
      state: { accounts: [], active: "system" },
      planAccounts: ["acct-plan"],
    });
  });
});
