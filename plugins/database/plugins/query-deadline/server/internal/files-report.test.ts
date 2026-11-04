import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createDbClient,
  queryDeadlineSink,
} from "@plugins/database/plugins/connection/server";
import {
  QueryDeadlineExceededError,
  startBlackHoleProxy,
  type BlackHoleProxy,
} from "@plugins/database/plugins/connection/server/testing";
import {
  PG_PORT,
  PG_SOCKET_DIR,
  PG_USER,
} from "@plugins/database/plugins/embedded/server";
import {
  installSpanContextRuntime,
  recordEntrySpan,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  DbQueryDeadlinePayloadSchema,
  QUERY_DEADLINE_RING_CAPACITY,
} from "../../core";
import { createQueryDeadlineHandler } from "./handler";
import { createHitRing } from "./hit-ring";
import { queryDeadlineFingerprint } from "./render";

// End to end, from a call whose bytes vanish to the report row it files: a REAL
// connection through the black-hole proxy (connection/server/testing), its
// deadline emitting on the REAL seam, drained by the REAL handler. The reports
// table's upsert is stood in for by a map keyed exactly as the engine keys a
// row — the kind's fingerprint — so a second miss from the same caller lands
// on the first one's row and raises its count.
//
// Requires the running embedded cluster (./equin build).

const DEADLINE_MS = 300;

const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

type ReportInput = Parameters<typeof recordReport>[0];

interface Row {
  count: number;
  data: unknown;
}

let proxy: BlackHoleProxy;

beforeAll(async () => {
  proxy = await startBlackHoleProxy({
    path: `${PG_SOCKET_DIR}/.s.PGSQL.${PG_PORT}`,
  });
});

afterEach(() => {
  queryDeadlineSink.register(null);
  proxy.setForwarding(true);
});

afterAll(async () => {
  await proxy.close();
  await new Promise((r) => setTimeout(r, 50));
});

async function lose(origin: string, sql: string): Promise<void> {
  const client = createDbClient({
    name: "events-test",
    connectionString: `postgres://${PG_USER}@127.0.0.1:${proxy.port}/postgres`,
    deadlineMs: DEADLINE_MS,
  });
  await client.connect();
  proxy.setForwarding(false);
  try {
    await recordEntrySpan("job", origin, () => client.query(sql));
    throw new Error("expected the call to be lost");
  } catch (err) {
    if (!(err instanceof QueryDeadlineExceededError)) throw err;
  } finally {
    proxy.setForwarding(true);
  }
}

describe("a forced deadline files a report", () => {
  it("files one row per caller; a second miss from it raises that row's count", async () => {
    const rows = new Map<string, Row>();
    const traces: string[] = [];
    queryDeadlineSink.register(
      createQueryDeadlineHandler({
        recordReport: (input: ReportInput) => {
          const data = DbQueryDeadlinePayloadSchema.parse(input.data);
          const fingerprint = queryDeadlineFingerprint(data);
          const row = rows.get(fingerprint);
          rows.set(fingerprint, { count: (row?.count ?? 0) + 1, data });
          return Promise.resolve({
            outcome: "recorded",
            reportId: fingerprint,
            taskId: null,
            rateLimited: false,
          });
        },
        captureTrace: (trigger) => {
          traces.push(trigger.label);
          return { id: `trace-${traces.length}` };
        },
        ring: createHitRing(QUERY_DEADLINE_RING_CAPACITY),
        notify: () => {},
        log: () => {},
      }),
    );

    await lose("conversations.usage:sync", "select 1 as first");
    expect([...rows.keys()]).toEqual([
      "db-query-deadline:events-test:query:origin=conversations.usage:sync",
    ]);
    expect(rows.get([...rows.keys()][0]!)!.count).toBe(1);

    // The same caller loses ANOTHER statement: the same row, count 2, its
    // payload now the latest call's.
    await lose("conversations.usage:sync", "select 2 as second");
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0]!;
    expect(row.count).toBe(2);
    const data = DbQueryDeadlinePayloadSchema.parse(row.data);
    expect(data).toMatchObject({
      pool: "events-test",
      phase: "query",
      sql: "select 2 as second",
      origin: "conversations.usage:sync",
      deadlineMs: DEADLINE_MS,
      transaction: "idle",
      traceId: "trace-2",
    });
    expect(data.elapsedMs).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(data.abandoned?.held).toBeGreaterThanOrEqual(2);
    expect(traces).toEqual(["events-test:query", "events-test:query"]);

    // Another caller is another row.
    await lose("tasks.maybe-launch", "select 3");
    expect(rows.size).toBe(2);
  });
});
