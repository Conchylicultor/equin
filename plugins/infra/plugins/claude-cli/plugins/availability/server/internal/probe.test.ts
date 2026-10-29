import { describe, expect, test } from "bun:test";
import { statusOfInitialize } from "./probe";

const VERSION = "2.1.308";

describe("statusOfInitialize", () => {
  test("signed in → ready, with version and account", () => {
    expect(
      statusOfInitialize({
        claude_code_version: VERSION,
        account: {
          email: "a@b.c",
          organization: "a@b.c's Organization",
          subscriptionType: "Claude Max",
          apiProvider: "firstParty",
        },
      }),
    ).toEqual({
      kind: "ready",
      version: VERSION,
      authMethod: "Claude Max",
      email: "a@b.c",
    });
  });

  test("a token in the environment → ready, named by its source", () => {
    expect(
      statusOfInitialize({
        claude_code_version: VERSION,
        account: {
          tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
          apiProvider: "firstParty",
        },
      }),
    ).toEqual({
      kind: "ready",
      version: VERSION,
      authMethod: "CLAUDE_CODE_OAUTH_TOKEN",
      email: null,
    });
  });

  test("a third-party provider signs in outside Claude Code → ready", () => {
    expect(
      statusOfInitialize({
        claude_code_version: VERSION,
        account: { apiProvider: "bedrock" },
      }),
    ).toMatchObject({ kind: "ready", authMethod: "bedrock" });
  });

  test("no credential → signed-out", () => {
    expect(
      statusOfInitialize({
        claude_code_version: VERSION,
        account: { tokenSource: "none", apiProvider: "firstParty" },
      }),
    ).toEqual({ kind: "signed-out", version: VERSION });
  });

  test("no version → unreadable, never a verdict", () => {
    expect(statusOfInitialize({ account: { email: "a@b.c" } }).kind).toBe(
      "unreadable",
    );
  });
});
