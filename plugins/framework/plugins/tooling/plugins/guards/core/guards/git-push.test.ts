import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { gitPushGuard } from "./git-push";

const root = mkdtempSync(join(tmpdir(), "git-push-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// An equin checkout: a `.git` FILE (as in a worktree) plus the CLI.
const equinRepo = join(root, "equin-wt");
mkdirSync(join(equinRepo, "plugins/framework/plugins/cli/bin"), {
  recursive: true,
});
mkdirSync(join(equinRepo, "src/deep"), { recursive: true });
writeFileSync(join(equinRepo, ".git"), "gitdir: elsewhere\n");
writeFileSync(join(equinRepo, "equin"), "#!/bin/sh\n");
writeFileSync(
  join(equinRepo, "plugins/framework/plugins/cli/bin/index.ts"),
  "",
);

// Some other repository.
const other = join(root, "pg-client-embedded");
mkdirSync(join(other, ".git"), { recursive: true });
mkdirSync(join(other, "src"), { recursive: true });

const notARepo = join(root, "plain");
mkdirSync(notARepo);

const blocks = (command: string, cwd: string) =>
  (gitPushGuard.check({ command }, createContext(cwd)) as Verdict).kind ===
  "deny";

describe("git-push guard targets only equin checkouts", () => {
  test("blocks a push from an equin checkout", () => {
    expect(blocks("git push origin main", equinRepo)).toBe(true);
  });

  test("blocks from a subdirectory of an equin checkout", () => {
    expect(blocks("git push", join(equinRepo, "src/deep"))).toBe(true);
  });

  test("allows a push from another repo", () => {
    expect(blocks("git push -u origin main", other)).toBe(false);
    expect(blocks("git push", join(other, "src"))).toBe(false);
  });

  test("follows cd into another repo", () => {
    expect(blocks(`cd ${other} && git push`, equinRepo)).toBe(false);
  });

  test("follows cd into an equin checkout", () => {
    expect(blocks(`cd ${equinRepo} && git push`, other)).toBe(true);
  });

  test("follows -C, relative to the call's cwd", () => {
    expect(blocks(`git -C ${other} push`, equinRepo)).toBe(false);
    expect(blocks("git -C ../equin-wt push", other)).toBe(true);
    expect(blocks(`git -c a.b=c -C ${equinRepo} push`, other)).toBe(true);
  });

  test("an equin push later in the chain is still caught", () => {
    expect(blocks(`git push; git -C ${equinRepo} push`, other)).toBe(true);
  });

  test("an unfollowed repository spelling is treated as equin", () => {
    expect(blocks(`git --git-dir=${other}/.git push`, other)).toBe(true);
    expect(blocks("GIT_DIR=.git git push", other)).toBe(true);
  });

  test("a directory that is no repo is treated as equin", () => {
    expect(blocks("git push", notARepo)).toBe(true);
  });

  test("other git subcommands are untouched", () => {
    expect(blocks("git -C . status", equinRepo)).toBe(false);
  });
});
