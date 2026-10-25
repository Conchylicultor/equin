import { describe, expect, test } from "bun:test";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import {
  identityInfo,
  linkedTaskIdOf,
  placeOf,
  summaryOf,
  type LinkedTask,
} from "./identity";

const PENDING: LinkedTask = { kind: "pending" };
const NONE: LinkedTask = { kind: "none" };
const LINKED: LinkedTask = {
  kind: "linked",
  taskId: "task-1",
  title: "Fix it",
};

describe("placeOf", () => {
  test("no namespace is local dev", () => {
    expect(placeOf(null)).toEqual({ kind: "local" });
  });

  test("the main namespace is the main checkout", () => {
    expect(placeOf(MAIN_WORKTREE_NAME)).toEqual({
      kind: "main",
      namespace: MAIN_WORKTREE_NAME,
    });
  });

  test("a lone label is an agent checkout of that name", () => {
    expect(placeOf(asNamespace("att-1"))).toEqual({
      kind: "worktree",
      namespace: asNamespace("att-1"),
      checkout: "att-1",
      composition: null,
    });
  });

  test("a composition namespace names its checkout half", () => {
    expect(placeOf(asNamespace("sonata.att-1"))).toEqual({
      kind: "worktree",
      namespace: asNamespace("sonata.att-1"),
      checkout: "att-1",
      composition: "sonata",
    });
  });
});

describe("linkedTaskIdOf", () => {
  const attempts = [
    { worktreePath: "/repo/.claude/worktrees/att-1", taskId: "task-1" },
    { worktreePath: "/repo/.claude/worktrees/att-10/", taskId: "task-10" },
  ];

  test("matches the attempt whose worktree path ends in the checkout", () => {
    expect(linkedTaskIdOf(attempts, "att-1")).toBe("task-1");
    expect(linkedTaskIdOf(attempts, "att-10")).toBe("task-10");
  });

  test("matches the whole final segment, not a suffix of it", () => {
    expect(linkedTaskIdOf(attempts, "1")).toBeNull();
    expect(linkedTaskIdOf(attempts, "att")).toBeNull();
  });

  test("no matching attempt is null", () => {
    expect(linkedTaskIdOf(attempts, "att-2")).toBeNull();
    expect(linkedTaskIdOf([], "att-1")).toBeNull();
  });
});

describe("summaryOf", () => {
  test("names what kind of place the namespace is", () => {
    expect(summaryOf(placeOf(null))).toBe("Served outside the gateway");
    expect(summaryOf(placeOf(MAIN_WORKTREE_NAME))).toBe(
      "equin · main checkout",
    );
    expect(summaryOf(placeOf(asNamespace("att-1")))).toBe(
      "att-1 · agent worktree",
    );
    expect(summaryOf(placeOf(asNamespace("sonata.att-1")))).toBe(
      "sonata.att-1 · sonata",
    );
  });
});

describe("identityInfo", () => {
  const worktree = placeOf(asNamespace("sonata.att-1"));

  test("local dev is titled as such whatever the lookup says", () => {
    expect(identityInfo(placeOf(null), NONE).title).toBe("Local dev");
  });

  test("a linked task titles the row", () => {
    expect(identityInfo(worktree, LINKED)).toEqual({
      title: "Fix it",
      summary: "sonata.att-1 · sonata",
    });
  });

  test("pending shows the namespace, exactly like no task", () => {
    expect(identityInfo(worktree, PENDING)).toEqual(
      identityInfo(worktree, NONE),
    );
    expect(identityInfo(worktree, PENDING).title).toBe("sonata.att-1");
  });

  test("the main checkout is titled by its namespace", () => {
    expect(identityInfo(placeOf(MAIN_WORKTREE_NAME), NONE)).toEqual({
      title: "equin",
      summary: "equin · main checkout",
    });
  });
});
