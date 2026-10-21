import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFileContent, getFileContentAtRef } from "./get-file-content";

// Fixture:
//   base/
//     repo/          (git init; a.txt)
//     outside.txt
let base: string;
let repo: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "file-content-test-")));
  repo = join(base, "repo");
  const init = Bun.spawnSync(["git", "init", "-q", repo]);
  expect(init.exitCode).toBe(0);
  writeFileSync(join(repo, "a.txt"), "inside");
  writeFileSync(join(base, "outside.txt"), "secret");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("code.file reads", () => {
  test("reads a relative path from disk", async () => {
    expect(await getFileContent(repo, "a.txt")).toEqual({
      kind: "ok",
      content: "inside",
    });
  });

  test("rejects an absolute path without a ref, even one that exists", async () => {
    expect(await getFileContent(repo, join(base, "outside.txt"))).toEqual({
      kind: "invalid-path",
    });
    expect(await getFileContent(repo, join(repo, "a.txt"))).toEqual({
      kind: "invalid-path",
    });
  });

  test("rejects a ~ path without a ref", async () => {
    expect(await getFileContent(repo, "~/.zshrc")).toEqual({
      kind: "invalid-path",
    });
  });

  test("rejects an absolute path at a ref", async () => {
    expect(
      await getFileContentAtRef(repo, join(base, "outside.txt"), "HEAD"),
    ).toEqual({ kind: "invalid-path" });
  });
});
