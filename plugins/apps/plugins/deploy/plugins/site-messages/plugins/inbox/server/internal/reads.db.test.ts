/**
 * The inbox's SQL on real Postgres: the keyset window paged in both
 * directions at its own cuts over messages whose instants collide, the scope
 * and filters, `:rows`, groups and count. Runs on a throwaway database's own
 * `site_messages` — in the app the same queries run on site-mirror's copy,
 * whose search_path names the copy's table instead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { Filter } from "@plugins/network/plugins/live/plugins/filter/core";
import { siteMessageIdKind } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { siteMessages } from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/server";
import type { SiteMessageRow } from "../../core";
import {
  deploymentOf,
  messageIdsByDeployment,
  readInboxCount,
  readInboxGroups,
  readInboxRows,
  readInboxWindow,
  type WindowQuery,
} from "./reads";

const DEPLOYMENT = "dpl-1-test";
const T = new Date("2026-11-12T10:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

let t: TestDb;
// Newest first, ties by id ascending: the order every window is checked against.
let expected: { id: string; createdAt: Date; verdict: string }[];

const scope = {
  column: "deploymentId",
  op: "eq",
  operand: DEPLOYMENT,
} as const;
const where = (...more: Filter[]): Filter =>
  more.length === 0 ? scope : { and: [scope, ...more] };

beforeAll(async () => {
  t = await createTestDb({ prefix: "site_messages_inbox_test" });
  await runMigrations(t.db);
  // Three messages at one instant (the id breaks the tie), one before, one after.
  const rows = [
    { createdAt: at(0), verdict: "accepted" as const, message: "hello one" },
    { createdAt: at(0), verdict: "accepted" as const, message: "hello two" },
    { createdAt: at(0), verdict: "spam" as const, message: "buy now" },
    { createdAt: at(-1000), verdict: "spam" as const, message: "buy later" },
    {
      createdAt: at(1000),
      verdict: "accepted" as const,
      message: "a question\nsecond line",
    },
  ].map((r) => ({
    ...r,
    id: siteMessageIdKind.mint(),
    replyTo: "visitor@example.com",
    host: "equin.ai",
    page: "/",
    ipHash: "h",
    spamReason: r.verdict === "spam" ? ("honeypot" as const) : null,
    notifyState:
      r.verdict === "spam" ? ("skipped" as const) : ("sent" as const),
  }));
  await t.db.insert(siteMessages).values(rows);
  expected = rows
    .map((r) => ({
      id: r.id as string,
      createdAt: r.createdAt,
      verdict: r.verdict,
    }))
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
});

afterAll(async () => {
  await t.drop();
});

const cutOf = (r: SiteMessageRow) => [r.createdAt.toISOString(), r.id] as const;

/** Every row, two at a time, each page cut after the last one's key. */
async function pageAll(
  dir: "asc" | "desc",
  w: Filter,
): Promise<SiteMessageRow[]> {
  const out: SiteMessageRow[] = [];
  for (;;) {
    const q: WindowQuery = {
      limit: 2,
      where: w,
      orderBy: [["createdAt", dir]],
      ...(out.length > 0 ? { after: cutOf(out.at(-1)!) } : {}),
    };
    const page = await readInboxWindow(t.db, DEPLOYMENT, q);
    out.push(...page);
    if (page.length < 2) return out;
  }
}

describe("the inbox window", () => {
  test("pages newest first at its own cuts, ties by id", async () => {
    const rows = await pageAll("desc", where());
    expect(rows.map((r) => r.messageId)).toEqual(expected.map((e) => e.id));
    expect(rows[0]!.id).toBe(`${DEPLOYMENT}/${expected[0]!.id}`);
    expect(rows[0]!.deploymentId).toBe(DEPLOYMENT);
    expect(rows[0]!.createdAt).toEqual(at(1000));
  });

  test("pages oldest first the same way", async () => {
    const rows = await pageAll("asc", where());
    const asc = [...expected].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    expect(rows.map((r) => r.messageId)).toEqual(asc.map((e) => e.id));
  });

  test("an until cut is inclusive", async () => {
    const all = await pageAll("desc", where());
    const rows = await readInboxWindow(t.db, DEPLOYMENT, {
      limit: 10,
      where: where(),
      orderBy: [["createdAt", "desc"]],
      after: cutOf(all[0]!),
      until: cutOf(all[2]!),
    });
    expect(rows.map((r) => r.id)).toEqual([all[1]!.id, all[2]!.id]);
  });

  test("filters by verdict and searches the message", async () => {
    const spam = await pageAll(
      "desc",
      where({ column: "verdict", op: "eq", operand: "spam" }),
    );
    expect(spam.map((r) => r.messageId)).toEqual(
      expected.filter((e) => e.verdict === "spam").map((e) => e.id),
    );
    const hello = await pageAll(
      "desc",
      where({ column: "message", op: "contains", operand: "hello" }),
    );
    expect(hello.map((r) => r.message).sort()).toEqual([
      "hello one",
      "hello two",
    ]);
  });

  test("counts and groups", async () => {
    expect(await readInboxCount(t.db, DEPLOYMENT, where())).toBe(5);
    expect(
      await readInboxCount(
        t.db,
        DEPLOYMENT,
        where({ column: "createdAt", op: "gte", operand: at(0).toISOString() }),
      ),
    ).toBe(4);
    expect(
      await readInboxGroups(t.db, DEPLOYMENT, {
        groupBy: "verdict",
        limit: 10,
        where: where(),
      }),
    ).toEqual([
      { value: "accepted", count: 3 },
      { value: "spam", count: 2 },
    ]);
    expect(
      await readInboxGroups(t.db, DEPLOYMENT, {
        groupBy: "createdAt",
        limit: 1,
        where: where(),
      }),
    ).toEqual([{ value: at(0).toISOString(), count: 3 }]);
  });

  test("reads rows by id, through the composite row id", async () => {
    const ids = [expected[0]!.id, expected[3]!.id].map(
      (id) => `${DEPLOYMENT}/${id}`,
    );
    const byDeployment = messageIdsByDeployment(ids);
    expect([...byDeployment.keys()]).toEqual([DEPLOYMENT]);
    const rows = await readInboxRows(
      t.db,
      DEPLOYMENT,
      byDeployment.get(DEPLOYMENT)!,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  test("a read naming no deployment is refused", () => {
    expect(() => deploymentOf(undefined)).toThrow(/names no deployment/);
    expect(() =>
      deploymentOf({ column: "verdict", op: "eq", operand: "spam" }),
    ).toThrow(/names no deployment/);
    expect(deploymentOf(where())).toEqual({
      kind: "deployment",
      id: DEPLOYMENT,
    });
    // An always-false filter folds the scope away: it matches nothing.
    expect(deploymentOf({ or: [] })).toEqual({ kind: "none" });
  });
});
