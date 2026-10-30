import { describe, expect, it } from "bun:test";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import { mapRow } from "./map-row";
import type { LiveRowResult } from "./use-live";

type Row = { id: string; level: number };
const refetch = () => Promise.resolve();
const double = (row: Row | null) => (row === null ? "absent" : row.level * 2);

describe("mapRow", () => {
  it("passes loading through", () => {
    const loading: LiveRowResult<Row> = {
      status: "loading",
      refetch,
    };
    expect(mapRow(loading, double)).toBe(loading);
  });

  it("maps a found row", () => {
    const r = mapRow<Row, number | string>(
      {
        status: "ready",
        found: true,
        row: { id: "a", level: 2 },
        refetch,
      },
      double,
    );
    expect(r).toEqual({ status: "ready", data: 4, refetch });
  });

  it("maps a settled miss through fn(null) — an absent row is an answer", () => {
    const r = mapRow<Row, number | string>(
      { status: "ready", found: false, refetch },
      double,
    );
    expect(r.status === "ready" && r.data).toBe("absent");
  });

  it("keeps the error arm, mapping its stale row when one is held", () => {
    const error = new ResourceError("loader-failed", "boom", null);
    const withStale = mapRow<Row, number | string>(
      {
        status: "error",
        error,
        stale: { id: "a", level: 3 },
        refetch,
      },
      double,
    );
    expect(withStale).toEqual({
      status: "error",
      error,
      stale: 6,
      refetch,
    });
    const bare = mapRow<Row, number | string>(
      { status: "error", error, refetch },
      double,
    );
    expect(bare.status).toBe("error");
    expect("stale" in bare).toBe(false);
  });
});
