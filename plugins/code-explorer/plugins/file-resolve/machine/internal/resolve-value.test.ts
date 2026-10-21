/**
 * code.resolve-file against a real temp checkout addressed by its absolute
 * toplevel: every answer kind, its candidate list capped with a `total`,
 * and the workspace refusals.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOLVE_MAX_MATCHES } from "../../shared/resolved-file";
import { loadResolvedFile } from "./resolve-value";

let base: string;
let repo: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "resolve-value-test-")));
  repo = join(base, "repo");
  for (let i = 0; i < RESOLVE_MAX_MATCHES + 5; i++) {
    mkdirSync(join(repo, `d${i}`), { recursive: true });
    writeFileSync(join(repo, `d${i}`, "index.ts"), "");
  }
  mkdirSync(join(repo, "only", "here"), { recursive: true });
  writeFileSync(join(repo, "only", "here", "unique.ts"), "");
  mkdirSync(join(base, "plain"));
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("code.resolve-file", () => {
  test("an existing path is exact; inside the checkout it comes back relative", async () => {
    expect(
      await loadResolvedFile({ worktree: repo, path: "only/here/unique.ts" }),
    ).toEqual({ kind: "exact", source: "git", path: "only/here/unique.ts" });
    expect(
      await loadResolvedFile({
        worktree: repo,
        path: join(repo, "only/here/unique.ts"),
      }),
    ).toEqual({ kind: "exact", source: "git", path: "only/here/unique.ts" });
  });

  test("a fuzzy path resolves through ls-files, capped with its total", async () => {
    expect(
      await loadResolvedFile({ worktree: repo, path: "here/unique.ts" }),
    ).toEqual({ kind: "resolved", matches: ["only/here/unique.ts"], total: 1 });
    const many = await loadResolvedFile({ worktree: repo, path: "index.ts" });
    expect(many.kind).toBe("resolved");
    if (many.kind !== "resolved") return;
    expect(many.matches).toHaveLength(RESOLVE_MAX_MATCHES);
    expect(many.total).toBe(RESOLVE_MAX_MATCHES + 5);
  });

  test("nothing matching is not-found; no checkout is refused", async () => {
    expect(await loadResolvedFile({ worktree: repo, path: "zzz.ts" })).toEqual({
      kind: "not-found",
    });
    expect(await loadResolvedFile({ worktree: repo, path: "" })).toEqual({
      kind: "not-found",
    });
    let code: string | undefined;
    try {
      await loadResolvedFile({ worktree: join(base, "plain"), path: "x" });
    } catch (err) {
      code = (err as { code: string }).code;
    }
    expect(code).toBe("no-workspace");
  });
});
