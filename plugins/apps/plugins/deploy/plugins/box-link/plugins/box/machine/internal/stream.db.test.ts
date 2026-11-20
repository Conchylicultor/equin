import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  ndjsonResponse,
  readNdjson,
} from "@plugins/infra/plugins/ndjson-stream/server";
import {
  BOX_LINK_PROTOCOL_VERSION,
  readBoxFrame,
  type BoxHostMetrics,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { BoxSignalSpec } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/box/server";
import { produceBoxStream } from "./stream";

// The box's stream against a real Postgres: a signal source that LISTENs the
// way table-mirror/source's does (a trigger NOTIFYs on insert), read back the
// way the link reads it (ndjsonResponse → readNdjson → readBoxFrame). Hello
// comes first, a committed insert arrives as a signal, beats follow, and the
// reader leaving releases the LISTEN.

type BoxFrame = Extract<
  ReturnType<typeof readBoxFrame>,
  { kind: "frame" }
>["frame"];

const CHANNEL = "box_link_stream_test";
const host: BoxHostMetrics = {
  cpu: { busyPct: null, cores: 2, load1: 0.5 },
  mem: { used: 1, total: 2 },
  disk: { used: 1, total: 2 },
  uptimeSec: 10,
};

let t: TestDb;
/** Every LISTEN session the source opened, and whether it was released. */
const sessions: { client: Client; ended: boolean }[] = [];

const listenSource: BoxSignalSpec = {
  source: "rows",
  async subscribe(emit) {
    const client = new Client({ connectionString: t.connectionString });
    await client.connect();
    const session = { client, ended: false };
    sessions.push(session);
    client.on("notification", (n) => {
      if (n.channel === CHANNEL) emit({ id: n.payload });
    });
    await client.query(`LISTEN ${CHANNEL}`);
    return () => {
      session.ended = true;
      void client.end();
    };
  },
};

beforeAll(async () => {
  t = await createTestDb({ prefix: "box_link" });
  await t.db.execute(
    sql.raw(`
    CREATE TABLE box_rows (id text PRIMARY KEY);
    CREATE FUNCTION box_rows_notify() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_notify('${CHANNEL}', NEW.id); RETURN NULL; END $$;
    CREATE TRIGGER box_rows_notify AFTER INSERT ON box_rows
      FOR EACH ROW EXECUTE FUNCTION box_rows_notify();
  `),
  );
});

afterAll(async () => {
  await t.drop();
});

/** Read frames until `until` says stop, then leave (cancelling the body). */
async function readUntil(
  res: Response,
  onFrame: (frame: BoxFrame, all: BoxFrame[]) => Promise<boolean> | boolean,
): Promise<BoxFrame[]> {
  const frames: BoxFrame[] = [];
  for await (const value of readNdjson(res.body!)) {
    const read = readBoxFrame(value);
    if (read.kind !== "frame")
      throw new Error(`unexpected read: ${JSON.stringify(read)}`);
    frames.push(read.frame);
    if (await onFrame(read.frame, frames)) break;
  }
  return frames;
}

describe("produceBoxStream", () => {
  test("hello, a signal on insert, beats; leaving releases the LISTEN", async () => {
    let reads = 0;
    const res = ndjsonResponse((emit, signal) =>
      produceBoxStream(emit, signal, {
        sources: [listenSource],
        readBuildId: () => Promise.resolve("abc123"),
        startedAt: 42,
        sampler: {
          read: () => {
            reads += 1;
            return Promise.resolve(host);
          },
        },
        beatMs: 50,
      }),
    );
    let inserted = false;
    const frames = await readUntil(res, async (frame, all) => {
      if (frame.kind === "beat" && !inserted) {
        inserted = true;
        await t.db.execute(sql.raw(`INSERT INTO box_rows VALUES ('r1')`));
      }
      return (
        all.some((f) => f.kind === "signal") &&
        all.filter((f) => f.kind === "beat").length >= 3
      );
    });

    expect(frames[0]).toEqual({
      kind: "hello",
      v: BOX_LINK_PROTOCOL_VERSION,
      startedAt: 42,
      buildId: "abc123",
      signals: ["rows"],
    });
    expect(frames[1]).toMatchObject({ kind: "beat", seq: 0, host });
    expect(frames.find((f) => f.kind === "signal")).toEqual({
      kind: "signal",
      source: "rows",
      payload: { id: "r1" },
    });
    const seqs = frames.flatMap((f) => (f.kind === "beat" ? [f.seq] : []));
    expect(seqs).toEqual(seqs.map((_, i) => i));

    // The reader left: the producer's abort releases the LISTEN and stops
    // beating.
    await Bun.sleep(120);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.ended).toBe(true);
    const readsAtLeave = reads;
    await Bun.sleep(150);
    expect(reads).toBe(readsAtLeave);
  });

  test("a source's subscription is open before hello is sent", async () => {
    const order: string[] = [];
    const res = ndjsonResponse((emit, signal) =>
      produceBoxStream(
        (frame) => {
          order.push(`emit:${(frame as { kind: string }).kind}`);
          emit(frame);
        },
        signal,
        {
          sources: [
            {
              source: "s",
              subscribe: async () => {
                await Bun.sleep(20);
                order.push("subscribed");
                return () => order.push("unsubscribed");
              },
            },
          ],
          readBuildId: () => Promise.resolve(null),
          startedAt: 1,
          sampler: { read: () => Promise.resolve(host) },
          beatMs: 1_000,
        },
      ),
    );
    await readUntil(res, (frame) => frame.kind === "beat");
    await Bun.sleep(20);
    expect(order).toEqual([
      "subscribed",
      "emit:hello",
      "emit:beat",
      "unsubscribed",
    ]);
  });
});
