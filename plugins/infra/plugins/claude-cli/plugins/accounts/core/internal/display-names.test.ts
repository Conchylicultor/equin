import { describe, expect, test } from "bun:test";
import { NO_CLAUDE_ACCOUNTS, type ClaudeAccounts } from "./accounts";
import { withStandInNames } from "./display-names";

const two: ClaudeAccounts = {
  accounts: [
    { id: "acct-1", name: "real-a", addedAt: 1, kind: "token" },
    { id: "acct-2", name: "real-b", addedAt: 2, kind: "token" },
  ],
  active: "acct-2",
  autoSwitch: false,
};

describe("withStandInNames", () => {
  test("empty stand-in shows the real names", () => {
    expect(withStandInNames(two, "")).toBe(two);
  });

  test("the active account bears the name, the others are numbered; ids untouched", () => {
    const shown = withStandInNames(two, "Claude");
    expect(shown.accounts.map((a) => a.name)).toEqual(["Claude 2", "Claude"]);
    expect(shown.accounts.map((a) => a.id)).toEqual(["acct-1", "acct-2"]);
    expect(shown.active).toBe("acct-2");
  });

  test("no added account stays the system account alone", () => {
    expect(withStandInNames(NO_CLAUDE_ACCOUNTS, "Claude")).toEqual(
      NO_CLAUDE_ACCOUNTS,
    );
  });

  test("the system account active: numbered from the first added", () => {
    const shown = withStandInNames({ ...two, active: "system" }, "Claude");
    expect(shown.accounts.map((a) => a.name)).toEqual(["Claude", "Claude 2"]);
  });
});
