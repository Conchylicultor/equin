import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import {
  AUTO_IDENTITY_KEY,
  decideIdentity,
  ensureCommitIdentity,
} from "./commit-identity";
import { gitConfigGet, gitConfigSet } from "./git-config";
import type { PublishTarget } from "./types";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

const LOCAL: PublishTarget = { kind: "local", reason: { kind: "no-remote" } };
const PUBLISH: PublishTarget = {
  kind: "publish",
  remote: "origin",
  url: "git@github.com:someone/fork.git",
};

describe("decideIdentity", () => {
  test("an explicit identity is used wherever the commit goes", () => {
    expect(decideIdentity("explicit", "local")).toBe("use");
    expect(decideIdentity("explicit", "publish")).toBe("use");
  });

  test("a clone that cannot publish never needs the user", () => {
    expect(decideIdentity("missing", "local")).toBe("write-auto");
    expect(decideIdentity("ours", "local")).toBe("use");
  });

  test("a placeholder never signs a commit that will be public", () => {
    expect(decideIdentity("missing", "publish")).toBe("refuse");
    expect(decideIdentity("ours", "publish")).toBe("remove-auto-then-recheck");
  });
});

// Real git, with every identity source outside the temp repo switched off:
// no global or system config, no identity in the environment.
const IDENTITY_ENV = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

describe("ensureCommitIdentity (real git)", () => {
  const saved = new Map<string, string | undefined>();
  let dir = "";

  beforeAll(() => {
    for (const k of IDENTITY_ENV) saved.set(k, process.env[k]);
    for (const k of IDENTITY_ENV) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    dir = mkdtempSync(join(tmpdir(), "commit-identity-"));
  });

  afterAll(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function freshRepo(name: string): Promise<string> {
    const root = join(dir, name);
    await spawnExpectOk(["git", "init", "-q", root], { timeoutMs: 60_000 });
    return root;
  }

  test("local: writes the placeholder once, and commits are signed with it", async () => {
    const root = await freshRepo("local");
    const first = await ensureCommitIdentity(root, LOCAL);
    expect(first).toMatchObject({ kind: "auto", written: true });
    if (first.kind !== "auto") throw new Error("unreachable");
    expect(first.email).toEndWith(`@${LEGACY_IDS.autoIdentityDomain}`);
    expect(await gitConfigGet(AUTO_IDENTITY_KEY, root)).toBe(first.email);

    const again = await ensureCommitIdentity(root, LOCAL);
    expect(again).toEqual({ ...first, written: false });

    await spawnExpectOk(["git", "commit", "-q", "--allow-empty", "-m", "x"], {
      cwd: root,
      timeoutMs: 60_000,
    });
    const author = await spawnExpectOk(["git", "log", "-1", "--format=%ae"], {
      cwd: root,
      timeoutMs: 60_000,
    });
    expect(author.stdout.trim()).toBe(first.email);
  });

  test("publish with nothing set: refuses, writes nothing", async () => {
    const root = await freshRepo("publish-missing");
    const result = await ensureCommitIdentity(root, PUBLISH);
    expect(result.kind).toBe("refuse");
    if (result.kind !== "refuse") throw new Error("unreachable");
    expect(result.message).toContain(PUBLISH.url);
    expect(await gitConfigGet("user.email", root)).toBeNull();
  });

  test("a clone that starts publishing drops the placeholder, then refuses", async () => {
    const root = await freshRepo("became-fork");
    await ensureCommitIdentity(root, LOCAL);
    const result = await ensureCommitIdentity(root, PUBLISH);
    expect(result.kind).toBe("refuse");
    for (const key of ["user.name", "user.email", AUTO_IDENTITY_KEY])
      expect(await gitConfigGet(key, root)).toBeNull();
  });

  test("an email the user set themselves is never touched", async () => {
    const root = await freshRepo("explicit");
    await ensureCommitIdentity(root, LOCAL);
    // The user overrides the placeholder: it is theirs now, not ours.
    await gitConfigSet("user.email", "me@example.com", root);
    expect(await ensureCommitIdentity(root, PUBLISH)).toEqual({
      kind: "explicit",
    });
    expect(await gitConfigGet("user.email", root)).toBe("me@example.com");
  });

  test("the environment counts as explicit", async () => {
    const root = await freshRepo("env");
    process.env.EMAIL = "env@example.com";
    try {
      expect(await ensureCommitIdentity(root, PUBLISH)).toEqual({
        kind: "explicit",
      });
    } finally {
      delete process.env.EMAIL;
    }
    const email = await spawnCaptured(
      ["git", "config", "--local", "--get", "user.email"],
      { cwd: root, timeoutMs: 60_000 },
    );
    expect(email.exitCode).toBe(1);
  });
});
