import { describe, expect, mock, test } from "bun:test";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { ActiveClaudeAccount } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import type { ClaudeCodeStatus } from "../../core";

// The computer's login, as the probe would answer it: signed out.
let probes = 0;
const signedOut: ClaudeCodeStatus = { kind: "signed-out", version: "2.1.0" };
void mock.module("./probe", () => ({
  probeClaudeCode: async () => {
    probes++;
    return signedOut;
  },
}));

const { checkLaunchReadiness, noteActiveAccountChanged, onClaudeCodeReady } =
  await import("./status");

const API_KEY_ACCOUNT = "acct-api";

function activeIs(id: string) {
  return [ActiveClaudeAccount.provide({ id: async () => id })];
}

describe("checkLaunchReadiness", () => {
  test("an added account launches while the computer is signed out, unprobed", async () => {
    probes = 0;
    const launch = await withHostServices(activeIs(API_KEY_ACCOUNT), () =>
      checkLaunchReadiness(),
    );
    expect(launch).toEqual({ kind: "ready" });
    expect(probes).toBe(0);
  });

  test("the system account is held back by the computer's sign-in", async () => {
    const launch = await withHostServices(activeIs(SYSTEM_ACCOUNT_ID), () =>
      checkLaunchReadiness(),
    );
    expect(launch).toEqual({ kind: "blocked", block: signedOut });
  });
});

describe("noteActiveAccountChanged", () => {
  test("wakes the ready listeners only on a switch to an added account", async () => {
    let wakes = 0;
    const off = onClaudeCodeReady(() => wakes++);
    const note = (id: string) =>
      withHostServices(activeIs(id), () => noteActiveAccountChanged());

    await note(SYSTEM_ACCOUNT_ID); // first sight: recorded, nothing switched
    expect(wakes).toBe(0);
    await note(SYSTEM_ACCOUNT_ID); // the file rewritten, same account
    expect(wakes).toBe(0);
    await note(API_KEY_ACCOUNT);
    expect(wakes).toBe(1);
    await note(SYSTEM_ACCOUNT_ID); // back to the computer's login: nothing new can run
    expect(wakes).toBe(1);
    off();
  });
});
