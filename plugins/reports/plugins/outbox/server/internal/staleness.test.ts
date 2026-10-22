import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { checkStaleness } from "./staleness";

// A throwaway repo with the history the rule reads:
//
//   base ── main: edits stack.ts
//     └──── feature: edits branch-only.ts, adds new.ts
//
// `mergeBase` is `base`, exactly what `git merge-base HEAD main` returns on
// the feature branch.
let root: string;
let mergeBase: string;

async function git(...args: string[]): Promise<string> {
  const result = await spawnExpectOk(
    [
      "git",
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, timeoutMs: 30_000 },
  );
  return result.stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "report-outbox-staleness-"));
  await git("init", "-q", "-b", "main");
  await writeFile(join(root, "stack.ts"), "export const a = 1;\n");
  await writeFile(join(root, "branch-only.ts"), "export const b = 1;\n");
  await writeFile(join(root, "untouched.ts"), "export const c = 1;\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  mergeBase = await git("rev-parse", "HEAD");

  await git("checkout", "-q", "-b", "feature");
  await writeFile(join(root, "branch-only.ts"), "export const b = 2;\n");
  await writeFile(join(root, "new.ts"), "export const d = 1;\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "feature");

  await git("checkout", "-q", "main");
  await writeFile(join(root, "stack.ts"), "export const a = 2;\n");
  await git("commit", "-q", "-am", "main fixes stack.ts");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const repo = () => ({ root, mainRef: "main" });

describe("checkStaleness", () => {
  test("main changed a file on the stack → stale, naming it", async () => {
    expect(
      await checkStaleness(
        { mergeBase, paths: ["untouched.ts", "stack.ts"] },
        repo(),
      ),
    ).toEqual({ kind: "stale", changed: ["stack.ts"] });
  });

  test("main left the stack's files alone → filed", async () => {
    expect(
      await checkStaleness({ mergeBase, paths: ["untouched.ts"] }, repo()),
    ).toEqual({ kind: "current" });
  });

  test("a change only the writer's branch made (even a new file) → filed", async () => {
    expect(
      await checkStaleness(
        { mergeBase, paths: ["branch-only.ts", "new.ts"] },
        repo(),
      ),
    ).toEqual({ kind: "current" });
  });

  test("no paths → filed, never a whole-tree diff", async () => {
    expect(await checkStaleness({ mergeBase, paths: [] }, repo())).toEqual({
      kind: "current",
    });
  });

  test("a merge-base this repository does not have → unknown-commit, never a diff", async () => {
    expect(
      await checkStaleness(
        { mergeBase: "c".repeat(40), paths: ["stack.ts"] },
        repo(),
      ),
    ).toEqual({ kind: "unknown-commit" });
  });

  test("a git failure → throws, never a verdict", async () => {
    let thrown: unknown = null;
    try {
      await checkStaleness(
        { mergeBase, paths: ["stack.ts"] },
        { root, mainRef: "no-such-ref" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("staleness check failed");
  });
});
