import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredential } from "./read-credential";

const tmp = mkdtempSync(join(tmpdir(), "deploy-secrets-read-"));
const saved = process.env.CREDENTIALS_DIRECTORY;
afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIALS_DIRECTORY;
  else process.env.CREDENTIALS_DIRECTORY = saved;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("readCredential", () => {
  test("no credentials directory (a dev worktree) is unset", () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    expect(readCredential("RESEND_API_KEY")).toEqual({ kind: "unset" });
  });

  test("reads the credential systemd decrypted, byte for byte", () => {
    process.env.CREDENTIALS_DIRECTORY = tmp;
    writeFileSync(join(tmp, "RESEND_API_KEY"), "re_123");
    expect(readCredential("RESEND_API_KEY")).toEqual({
      kind: "set",
      value: "re_123",
    });
  });

  test("a key the deployment has no credential for is unset", () => {
    process.env.CREDENTIALS_DIRECTORY = tmp;
    expect(readCredential("OTHER_KEY")).toEqual({ kind: "unset" });
  });

  test("an empty credential is unset, never an empty key", () => {
    process.env.CREDENTIALS_DIRECTORY = tmp;
    writeFileSync(join(tmp, "EMPTY_KEY"), "");
    expect(readCredential("EMPTY_KEY")).toEqual({ kind: "unset" });
  });

  test("a credential that exists but cannot be read throws", () => {
    process.env.CREDENTIALS_DIRECTORY = tmp;
    mkdirSync(join(tmp, "A_DIRECTORY"));
    expect(() => readCredential("A_DIRECTORY")).toThrow();
  });
});
