/**
 * The mandate column against the REAL worktree DB, inside a rolled-back
 * transaction (`worktreeDbScenario`): nearest-wins resolution up `folder_id`,
 * the re-file-to-root copy, `clearMandate`'s refusal on a root, and the
 * `tasks_root_has_mandate` CHECK. Needs this worktree's DB as `./equin build`
 * leaves it (the migration adding the column and the CHECK applied).
 *
 * Run: `./equin test plugins/tasks/plugins/tasks-core`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { worktreeDbScenario } from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import {
  defineCapability,
  mandatePolicy,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";
import {
  clearMandate,
  createTask,
  setMandate,
  updateTask,
} from "../mutations/tasks";
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

const level = defineCapability<"root" | "nested">({
  id: "test.level",
  schema: z.enum(["root", "nested"]),
  label: "Level",
});
const ROOT = mandatePolicy([level.grant("root")]);
const NESTED = mandatePolicy([level.grant("nested")]);

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
      policy: ROOT,
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
      policy: NESTED,
    });
    expect(found.forRoot).toMatchObject({ policy: ROOT });
  });

  test("clearing a nested mandate falls back to the ancestor's", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await createTask({ title: "root", mandate: ROOT }, tx);
      const child = await createTask({ folderId: root.id, title: "c" }, tx);
      await setMandate(child.id, NESTED, tx);
      await clearMandate(child.id, tx);
      return nearestMandate(child.id, tx);
    });
    expect(got).toMatchObject({ policy: ROOT });
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
      policy: ROOT,
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
