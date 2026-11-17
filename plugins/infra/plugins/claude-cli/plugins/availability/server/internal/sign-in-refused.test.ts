import { describe, expect, mock, test } from "bun:test";
import type { ClaudeCodeStatus } from "../../core";

// The computer's login, as the probe would answer it: a credential is present.
const ready: ClaudeCodeStatus = {
  kind: "ready",
  version: "2.1.0",
  authMethod: "Claude Max",
  email: "a@b.c",
};
void mock.module("./probe", () => ({ probeClaudeCode: async () => ready }));

const {
  checkClaudeCode,
  currentClaudeCodeStatus,
  noteClaudeCodeSignInRefused,
  recheckClaudeCodeNow,
  recheckClaudeCodeOnReturn,
} = await import("./status");

const refused: ClaudeCodeStatus = { kind: "sign-in-refused", version: "2.1.0" };

describe("noteClaudeCodeSignInRefused", () => {
  test("a refusal holds over probes that still see a credential, until the user checks again", async () => {
    expect(await checkClaudeCode()).toEqual(ready);
    noteClaudeCodeSignInRefused();
    expect(await currentClaudeCodeStatus()).toEqual(refused);
    // The launch gate re-probes a block: the probe still sees a credential.
    expect(await checkClaudeCode()).toEqual(refused);
    // Coming back to the window keeps it.
    expect(await recheckClaudeCodeOnReturn()).toEqual(refused);
    // The user's Check again (or a finished sign-in) drops it.
    expect(await recheckClaudeCodeNow()).toEqual(ready);
    expect(await checkClaudeCode()).toEqual(ready);
  });
});
