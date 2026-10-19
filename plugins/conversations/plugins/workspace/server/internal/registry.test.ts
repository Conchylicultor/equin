import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetWorkspaceRegistry,
  Workspace,
  type WorkspaceImpl,
} from "./registry";

function fakeImpl<K extends "worktree" | "scratch">(
  kind: K,
  root: string,
): WorkspaceImpl<K> {
  return {
    kind,
    root: async () => root,
    parseSpec: (spec) => spec,
    onCommit: async () => {},
    prepare: async () => {},
    onFinish: async () => {},
    launch: () => ({ settings: {} }),
    checkResumable: () => ({ kind: "ok" }),
  };
}

// `Registration.register` may be async; this one is not, but is awaited as one.
async function register<K extends "worktree" | "scratch">(
  impl: WorkspaceImpl<K>,
) {
  await Workspace.define(impl).register();
}

// Other suites in the same process install impls of their own.
beforeEach(resetWorkspaceRegistry);

describe("Workspace registry", () => {
  test("define registers on the register phase, not before", async () => {
    const token = Workspace.define(
      fakeImpl("worktree", "/repo/.claude/worktrees"),
    );
    expect(() => Workspace.get("worktree")).toThrow(
      'Unknown workspace kind "worktree"',
    );
    await token.register();
    expect(Workspace.get("worktree").kind).toBe("worktree");
    expect(Workspace.all().map((w) => w.kind)).toEqual(["worktree"]);
  });

  test("a second impl of one kind throws", async () => {
    await register(fakeImpl("worktree", "/a"));
    // Synchronous for a sync registration: it throws at `.register()`.
    expect(() =>
      Workspace.define(fakeImpl("worktree", "/b")).register(),
    ).toThrow('Workspace kind "worktree" already registered');
  });

  test("an unregistered kind throws", async () => {
    await register(fakeImpl("worktree", "/a"));
    expect(() => Workspace.get("scratch")).toThrow(
      'Unknown workspace kind "scratch"',
    );
  });
});

describe("workspace paths", () => {
  test("pathFor is the attempt id directly under the kind's root", async () => {
    await register(fakeImpl("worktree", "/repo/.claude/worktrees"));
    expect(await Workspace.pathFor("worktree", "att-1")).toBe(
      "/repo/.claude/worktrees/att-1",
    );
  });

  test("resolvePath inverts pathFor for every registered kind", async () => {
    await register(fakeImpl("worktree", "/repo/.claude/worktrees"));
    await register(fakeImpl("scratch", "/home/.singularity/workspaces"));
    for (const kind of ["worktree", "scratch"] as const) {
      const path = await Workspace.pathFor(kind, "att-7");
      expect(await Workspace.resolvePath(path)).toEqual({
        kind,
        attemptId: "att-7",
      });
    }
  });

  test("a directory that is no workspace resolves to none", async () => {
    await register(fakeImpl("worktree", "/repo/.claude/worktrees"));
    // The repo root, a nested dir, an unrelated dir.
    for (const path of [
      "/repo",
      "/repo/.claude/worktrees/att-1/sub",
      "/tmp/att-1",
    ]) {
      expect(await Workspace.resolvePath(path)).toBe("none");
    }
  });
});
