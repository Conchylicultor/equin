import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "./context";

function withCheckout(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "guard-context-"));
  try {
    // A worktree's `.git` is a file; classifyRepo only asks that it exist.
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

describe("hasBypass", () => {
  test("a file at the checkout root counts from a subdirectory", () => {
    withCheckout((root) => {
      const sub = join(root, "plugins", "menu-bar", "rust");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(root, ".allow-x"), "");
      expect(createContext(sub).hasBypass(".allow-x")).toBe(true);
      expect(createContext(root).hasBypass(".allow-x")).toBe(true);
    });
  });

  test("a file in a subdirectory does not count", () => {
    withCheckout((root) => {
      const sub = join(root, "plugins");
      mkdirSync(sub);
      writeFileSync(join(sub, ".allow-x"), "");
      expect(createContext(sub).hasBypass(".allow-x")).toBe(false);
    });
  });

  test("outside any repo, the cwd itself is the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-context-"));
    try {
      expect(createContext(dir).hasBypass(".allow-x")).toBe(false);
      writeFileSync(join(dir, ".allow-x"), "");
      expect(createContext(dir).hasBypass(".allow-x")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
