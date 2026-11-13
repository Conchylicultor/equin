import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { postgresGuard } from "./postgres";

function withCheckout(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "guard-postgres-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

describe("postgres guard's bypass hint", () => {
  test("names the bypass file's absolute path, created in its own call", () => {
    withCheckout((root) => {
      const v = postgresGuard.check(
        { command: "psql -l" },
        createContext(root),
      ) as Verdict;
      expect(v.kind).toBe("deny");
      const reason = v.kind === "deny" ? v.reason : "";
      // The exact file the guard reads, so the agent cannot create it elsewhere.
      expect(reason).toContain(`touch ${join(root, ".allow-postgres")}`);
      // A `touch` chained into the blocked call is judged before it runs.
      expect(reason).toContain("as its OWN tool call first");
    });
  });

  test("lets the call through once the file exists", () => {
    withCheckout((root) => {
      writeFileSync(join(root, ".allow-postgres"), "");
      const v = postgresGuard.check(
        { command: "psql -l" },
        createContext(root),
      ) as Verdict;
      expect(v.kind).toBe("allow");
    });
  });
});
