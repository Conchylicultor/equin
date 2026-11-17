import { describe, expect, test } from "bun:test";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import { identityInfo, placeOf, type LinkedTask } from "./identity";

const PENDING: LinkedTask = { kind: "pending" };
const NONE: LinkedTask = { kind: "none" };
const LINKED: LinkedTask = {
  kind: "linked",
  taskId: "task-1",
  shortTitle: "Health row",
};
const NO_SHORT: LinkedTask = {
  kind: "linked",
  taskId: "task-1",
  shortTitle: null,
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

describe("identityInfo", () => {
  const agent = placeOf(asNamespace("att-1"));
  const composed = placeOf(asNamespace("sonata.att-1"));

  test("local dev is titled as such whatever the lookup says", () => {
    expect(identityInfo(placeOf(null), LINKED)).toEqual({
      title: "Local dev",
      summary: "Served outside the gateway",
    });
  });

  test("the main checkout is titled by its kind, its namespace below", () => {
    expect(identityInfo(placeOf(MAIN_WORKTREE_NAME), NONE)).toEqual({
      title: "Main checkout",
      summary: "equin",
    });
  });

  test("an agent worktree: the short title, then the checkout", () => {
    expect(identityInfo(agent, LINKED)).toEqual({
      title: "Agent worktree",
      summary: "Health row · att-1",
    });
  });

  test("a composition on a worktree is titled by the composition", () => {
    expect(identityInfo(composed, LINKED)).toEqual({
      title: "Sonata worktree",
      summary: "Health row · att-1",
    });
  });

  test("without a short title the summary is the checkout alone", () => {
    for (const task of [PENDING, NONE, NO_SHORT, { kind: "failed" } as const]) {
      expect(identityInfo(agent, task)).toEqual({
        title: "Agent worktree",
        summary: "att-1",
      });
    }
  });
});
