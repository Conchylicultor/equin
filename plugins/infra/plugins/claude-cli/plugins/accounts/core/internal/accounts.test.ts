import { describe, expect, test } from "bun:test";
import { ClaudeCredentialSchema, claudeCredentialEnv } from "./accounts";

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;
const KEY = `sk-ant-api03-${"b".repeat(40)}`;
const USER_KEY = `sk-ant-usr-${"d".repeat(40)}`;

describe("credentials", () => {
  test("an API key is accepted; a plan token or anything else is refused", () => {
    expect(ClaudeCredentialSchema.safeParse(KEY).success).toBe(true);
    expect(ClaudeCredentialSchema.safeParse(USER_KEY).success).toBe(true);
    expect(ClaudeCredentialSchema.safeParse(` ${KEY} `).success).toBe(true);
    expect(ClaudeCredentialSchema.safeParse(TOKEN).success).toBe(false);
    expect(
      ClaudeCredentialSchema.safeParse(`sk-ant-admin01-${"c".repeat(40)}`)
        .success,
    ).toBe(false);
  });

  test("the env carries the API key and no other credential", () => {
    const base = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "stale" };
    expect(claudeCredentialEnv(base, KEY)).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: KEY,
    });
    expect(
      claudeCredentialEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "stale" }, KEY),
    ).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: KEY });
  });
});
