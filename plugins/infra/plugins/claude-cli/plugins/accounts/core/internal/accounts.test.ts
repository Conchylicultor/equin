import { describe, expect, test } from "bun:test";
import {
  ClaudeAccountSchema,
  ClaudeCredentialSchema,
  claudeCredentialEnv,
  claudeCredentialKind,
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
