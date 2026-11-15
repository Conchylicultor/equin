/**
 * A role's backlog against the REAL worktree DB (it reads `tasks_v`), inside
 * rolled-back transactions: a task FILED there (a root stating the
 * interactive mandate) and a task a person ROUTED there (nested in its tree,
 * stating no mandate) both count; the role's session root does not.
 *
 * Run: `./equin test plugins/tasks/plugins/supervisor-roles`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { isInRoleBacklog, roleBacklog } from "./roles";

let seq = 0;
const uid = (k: string) => `${k}-sr${Date.now()}-${++seq}`;

async function task(
  tx: DbExecutor,
  opts: { folderId: string | null; mandate: string | null; owner?: string },
): Promise<string> {
  const id = uid("task");
  await tx.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref, author_kind)
    VALUES (${id}, ${opts.folderId ?? id}, 'T', true, ${id}, ${opts.folderId}, now(), now(), ${opts.mandate}, 'human')
  `);
  if (opts.owner !== undefined)
    await tx.execute(sql`
      INSERT INTO tasks_ext_supervisor (parent_id, supervisor) VALUES (${id}, ${opts.owner})
    `);
  return id;
}

describe("role backlog", () => {
  test("a routed nested task (no stated mandate) is in the backlog, as a filed root is", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const role = uid("srole");
      await tx.execute(
        sql`INSERT INTO supervisor_roles (id, name) VALUES (${role}, ${role})`,
      );
      const session = await task(tx, {
        folderId: null,
        mandate: "supervisor-role",
        owner: role,
      });
      const filed = await task(tx, {
        folderId: null,
        mandate: "interactive",
        owner: role,
      });
      const parent = await task(tx, { folderId: null, mandate: "interactive" });
      const routed = await task(tx, {
        folderId: parent,
        mandate: null,
        owner: role,
      });
      return {
        filed: await isInRoleBacklog(filed, role, tx),
        routed: await isInRoleBacklog(routed, role, tx),
        session: await isInRoleBacklog(session, role, tx),
        backlog: (await roleBacklog(role, tx)).map((r) => r.id).sort(),
        expected: [filed, routed].sort(),
      };
    });
    expect(got.filed).toBe(true);
    expect(got.routed).toBe(true);
    expect(got.session).toBe(false);
    expect(got.backlog).toEqual(got.expected);
  });
});
