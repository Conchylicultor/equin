import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { probeClaudeCode, statusOfInitialize } from "./probe";

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

describe("probeClaudeCode", () => {
  const saved = readEnv("CLAUDE_BIN");
  afterEach(() => {
    if (saved === undefined) unsetEnv("CLAUDE_BIN");
    else setEnv("CLAUDE_BIN", saved);
  });

  test("no executable → missing, naming where it looked", async () => {
    const nowhere = join(mkdtempSync(join(tmpdir(), "sg-claude-probe-")), "x");
    setEnv("CLAUDE_BIN", nowhere);
    expect(await probeClaudeCode()).toEqual({
      kind: "missing",
      searched: [nowhere],
    });
  });
});
