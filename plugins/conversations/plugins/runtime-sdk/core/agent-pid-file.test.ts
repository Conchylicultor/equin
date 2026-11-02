import { describe, expect, test } from "bun:test";
import { agentPidFileAccount, agentPidFileText } from "./agent-pid-file";

describe("agent pid file", () => {
  test("names the pid first, then the account", () => {
    const text = agentPidFileText(4242, "acct-work");
    expect(text.split("\n")[0]).toBe("4242");
    expect(agentPidFileAccount(text)).toBe("acct-work");
  });

  test("a file from before pid files named the account names none", () => {
    expect(agentPidFileAccount("4242\n")).toBeNull();
  });
});
