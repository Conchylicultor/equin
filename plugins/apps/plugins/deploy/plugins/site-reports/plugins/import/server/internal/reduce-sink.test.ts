import { describe, expect, test } from "bun:test";
import { IMPORT_PACE, reduceSink } from "./reduce-sink";

const site = { deploymentId: "dpl-1", hostnames: ["example.com"] };
const sink = reduceSink(site);
const opts = { reconciling: false, firstCopy: false };
const upsert = (i: number) => ({
  pk: { fingerprint: `crash:${i}` },
  h: "0".repeat(32),
  row: JSON.stringify({
    fingerprint: `crash:${i}`,
    kind: "crash",
    source: "browser-error",
    message: "m",
    data: {},
    path: "/",
    build_id: null,
    commit: null,
    count: 1,
    first_seen_at: "2026-11-12T00:00:00+00:00",
    last_seen_at: "2026-11-12T00:00:00+00:00",
  }),
});
const tx = {} as Parameters<typeof sink.apply>[0];

describe("reduceSink", () => {
  test("nothing handed (tombstones only) records nothing", async () => {
    await sink.apply(
      tx,
      [{ table: "site_reports", upserts: [], deletes: [{ fingerprint: "x" }] }],
      opts,
    );
  });

  test("a page past the pace's flood bound throws instead of recording", () => {
    const upserts = Array.from({ length: IMPORT_PACE.rowsPerRun + 1 }, (_, i) =>
      upsert(i),
    );
    expect(
      sink.apply(tx, [{ table: "site_reports", upserts, deletes: [] }], opts),
    ).rejects.toThrow(/past the pace/);
  });

  test("a table other than site_reports throws", () => {
    expect(
      sink.apply(
        tx,
        [{ table: "other", upserts: [upsert(1)], deletes: [] }],
        opts,
      ),
    ).rejects.toThrow(/reduces site_reports only/);
  });
});
