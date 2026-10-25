import { describe, expect, test } from "bun:test";
import type { SshKey } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { installCommand } from "./install-command";

const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIJk1r7Xz2VqQwqRPq1J8v3wKZ6f0Lm9dQxK4tYh2sJ0e";

function key(comment: string): SshKey {
  return {
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:8yF2abcdefghijklmnopqrstuvwxyz0123456789ABC",
    comment,
    publicKey: `ssh-ed25519 ${BLOB} ${comment}`,
  };
}

describe("installCommand", () => {
  test("installs the key with the restrict,pty prefix", () => {
    const cmd = installCommand(key("equin-deploy-srv-1"));
    expect(cmd).toContain(
      `restrict,pty ssh-ed25519 ${BLOB} equin-deploy-srv-1`,
    );
  });

  test("appends via printf with a leading newline, never echo", () => {
    const cmd = installCommand(key("equin-deploy-srv-1"));
    expect(cmd).toContain(`printf '\\n%s\\n' `);
    expect(cmd).toContain(">> ~/.ssh/authorized_keys");
    expect(cmd).not.toContain("echo ");
  });

  test("self-cleans the previous key via an anchored sed address", () => {
    const cmd = installCommand(key("equin-deploy-srv-1"));
    expect(cmd).toContain(
      "sed -i.bak '/ equin-deploy-srv-1$/d' ~/.ssh/authorized_keys",
    );
  });

  test.each([
    ["a space", "equin deploy srv-1"],
    ["a quote", "equin-deploy-srv'1"],
    ["a regex metacharacter", "equin-deploy-.*"],
  ])("omits the sed clause for a comment with %s", (_label, comment) => {
    const cmd = installCommand(key(comment));
    expect(cmd).not.toContain("sed");
    // The key is still installed — refusing to clean is not refusing to work.
    expect(cmd).toContain("authorized_keys");
    expect(cmd).toContain("restrict,pty ssh-ed25519");
  });

  test("single-quotes the installed line so a quoted comment cannot break out", () => {
    const cmd = installCommand(key("equin-deploy-srv'1"));
    expect(cmd).toContain(
      `printf '\\n%s\\n' 'restrict,pty ssh-ed25519 ${BLOB} equin-deploy-srv'\\''1'`,
    );
  });
});
