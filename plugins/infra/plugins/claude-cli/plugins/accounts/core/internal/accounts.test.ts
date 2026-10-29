import { describe, expect, test } from "bun:test";
import { readLiveEffect } from "@plugins/network/plugins/live/core";
import {
  ClaudeAccountSchema,
  ClaudeCredentialSchema,
  claudeCredentialEnv,
  claudeCredentialKind,
  removeClaudeAccount,
  selectClaudeAccount,
  setClaudeAccountAutoSwitch,
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccounts,
} from "./accounts";

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;
const KEY = `sk-ant-api03-${"b".repeat(40)}`;

describe("credentials", () => {
  test("the kind is derived from the prefix; anything else is refused", () => {
    expect(claudeCredentialKind(TOKEN)).toBe("token");
    expect(claudeCredentialKind(KEY)).toBe("api-key");
    expect(ClaudeCredentialSchema.safeParse(` ${KEY} `).success).toBe(true);
    expect(
      ClaudeCredentialSchema.safeParse(`sk-ant-admin01-${"c".repeat(40)}`)
        .success,
    ).toBe(false);
    expect(() => claudeCredentialKind("sk-ant-admin01-x")).toThrow();
  });

  test("the env carries exactly the credential's own variable", () => {
    const base = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "stale" };
    expect(claudeCredentialEnv(base, { kind: "api-key", secret: KEY })).toEqual(
      { PATH: "/bin", ANTHROPIC_API_KEY: KEY },
    );
    expect(
      claudeCredentialEnv(
        { PATH: "/bin", ANTHROPIC_API_KEY: "stale" },
        { kind: "token", secret: TOKEN },
      ),
    ).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  test("an account saved before API keys reads as a token account", () => {
    expect(
      ClaudeAccountSchema.parse({ id: "acct-1", name: "Work", addedAt: 1 })
        .kind,
    ).toBe("token");
  });
});

const state: ClaudeAccounts = {
  accounts: [
    { id: "a", name: "A", addedAt: 1, kind: "token" },
    { id: "b", name: "B", addedAt: 2, kind: "api-key" },
  ],
  active: "a",
  autoSwitch: false,
};

function apply(effect: Parameters<typeof readLiveEffect>[0], body: unknown) {
  const [t] = readLiveEffect(effect).resolve({ params: {}, body }).targets;
  if (t === undefined || t.kind !== "value") throw new Error("value target");
  expect(t.key).toBe("claude-accounts");
  return t.apply(state);
}

describe("claude account effects", () => {
  test("select makes the account active", () => {
    expect(apply(selectClaudeAccount.effect, { id: "b" })).toEqual({
      ...state,
      active: "b",
    });
  });

  test("auto-switch sets the flag", () => {
    expect(apply(setClaudeAccountAutoSwitch.effect, { enabled: true })).toEqual(
      { ...state, autoSwitch: true },
    );
  });

  test("removing the active account falls back to the system one", () => {
    expect(apply(removeClaudeAccount.effect, { id: "a" })).toEqual({
      accounts: [state.accounts[1]!],
      active: SYSTEM_ACCOUNT_ID,
      autoSwitch: false,
    });
    expect(apply(removeClaudeAccount.effect, { id: "b" })).toMatchObject({
      active: "a",
    });
  });
});
