/**
 * The mandate column against the REAL worktree DB, inside a rolled-back
 * transaction (`worktreeDbScenario`): nearest-wins resolution up `folder_id`,
 * the re-file-to-root copy, `clearMandate`'s refusal on a root, the
 * `tasks_root_has_mandate` CHECK, and every task's effective mandate
 * (`tasks_ext_mandate`) kept exact by each write that moves it. Needs this worktree's DB as `./equin build`
 * leaves it (the migration adding the column and the CHECK applied).
 *
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { worktreeDbScenario } from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { defineMandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import {
  clearMandate,
  createTask,
  setMandate,
  updateTask,
} from "../mutations/tasks";
import { refreshEffectiveMandates } from "../mutations/mandate";
import { tasksMandate } from "../tables-mandate";
import type { DbExecutor } from "../status-batch";
import { nearestMandate } from "./tasks";

/** The Error `p` rejected with; throws if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// Never resolved here: tasks-core stores and walks ids only.
const ROOT = defineMandate({ id: "test-root", label: "Root" });
const NESTED = defineMandate({ id: "test-nested", label: "Nested" });

/** Each task's materialized effective mandate id (`tasks_ext_mandate`). */
async function effective(
  tx: DbExecutor,
  ids: readonly string[],
): Promise<(string | null)[]> {
  return Promise.all(
    ids.map(async (id) => (await tasksMandate.get(id, tx))?.mandateId ?? null),
  );
}

describe("nearestMandate", () => {
  test("a task with no mandate of its own inherits its nearest ancestor's", async () => {
    const found = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      const grandchild = await createTask(
        { folderId: child.id, title: "gc" },
        tx,
      );
      return { root: root.id, got: await nearestMandate(grandchild.id, tx) };
    });
    expect(found.got).toEqual({
      kind: "found",
      rootTaskId: found.root,
      mandateId: ROOT.id,
    });
  });

  test("a nested mandate wins over its ancestors' — for its whole subtree", async () => {
    const found = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      const grandchild = await createTask(
        { folderId: child.id, title: "gc" },
        tx,
      );
      await setMandate(child.id, NESTED, tx);
      return {
        child: child.id,
        forGrandchild: await nearestMandate(grandchild.id, tx),
        forRoot: await nearestMandate(root.id, tx),
      };
    });
    expect(found.forGrandchild).toEqual({
      kind: "found",
      rootTaskId: found.child,
      mandateId: NESTED.id,
    });
    expect(found.forRoot).toMatchObject({ mandateId: ROOT.id });
  });

  test("clearing a nested mandate falls back to the ancestor's", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      await setMandate(child.id, NESTED, tx);
      await clearMandate(child.id, tx);
      return nearestMandate(child.id, tx);
    });
    expect(got).toMatchObject({ mandateId: ROOT.id });
  });

  test("a task that does not exist resolves to none", async () => {
    const got = await worktreeDbScenario((tx) =>
      nearestMandate("mandate-test-missing", tx),
    );
    expect(got).toEqual({ kind: "none" });
  });
});

describe("root mandate invariant", () => {
  test("re-filing a task to the root copies its effective mandate onto it", async () => {
    const found = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      await updateTask(child.id, { folderId: null }, tx);
      return { child: child.id, got: await nearestMandate(child.id, tx) };
    });
    expect(found.got).toEqual({
      kind: "found",
      rootTaskId: found.child,
      mandateId: ROOT.id,
    });
  });

  test("clearMandate refuses on a root", async () => {
    const err = await rejection(
      worktreeDbScenario(async (tx) => {
        const root = await createTask({ title: "root", mandate: ROOT }, tx);
        await clearMandate(root.id, tx);
      }),
    );
    expect(err.message).toMatch(/is a root/);
  });

  test("the CHECK refuses a root row without a mandate", async () => {
    const err = await rejection(
      worktreeDbScenario((tx) =>
        tx.execute(sql`
          INSERT INTO tasks (id, title, title_auto, rank)
          VALUES ('mandate-test-bare-root', 'bare', false, 'a0')`),
      ),
    );
    expect(`${err.message} ${String(err.cause ?? "")}`).toMatch(
      /tasks_root_has_mandate/,
    );
  });
});

describe("effective mandate", () => {
  test("follows create, a nested mandate, its clearing and a re-file", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const other = await createTask({ title: "other", mandate: NESTED }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      const grandchild = await createTask(
        { folderId: child.id, title: "gc" },
        tx,
      );
      const ids = [child.id, grandchild.id];
      const created = await effective(tx, ids);
      await setMandate(child.id, NESTED, tx);
      const nested = await effective(tx, ids);
      await clearMandate(child.id, tx);
      const cleared = await effective(tx, ids);
      await updateTask(child.id, { folderId: other.id }, tx);
      const refiled = await effective(tx, ids);
      await updateTask(child.id, { folderId: null }, tx);
      const toRoot = await effective(tx, ids);
      // A refresh that moves nothing writes nothing.
      await refreshEffectiveMandates([child.id], tx);
      return { created, nested, cleared, refiled, toRoot };
    });
    expect(got.created).toEqual([ROOT.id, ROOT.id]);
    expect(got.nested).toEqual([NESTED.id, NESTED.id]);
    expect(got.cleared).toEqual([ROOT.id, ROOT.id]);
    expect(got.refiled).toEqual([NESTED.id, NESTED.id]);
    // Re-filed to the root, it keeps the mandate it had under its folder.
    expect(got.toRoot).toEqual([NESTED.id, NESTED.id]);
  });
});
