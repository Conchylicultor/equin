import { describe, expect, it } from "bun:test";
import { rowFailed, rowPending } from "@plugins/network/plugins/live/core";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { FieldValue } from "../../core";
import {
  foldFieldRead,
  partitionKnownRows,
  splitRowReader,
  stampExtensionRead,
} from "./field-read";

const refetch = () => Promise.resolve();
const boom = new Error("probe failed");

describe("splitRowReader", () => {
  it("answers value and state from ONE call per row", () => {
    const calls: string[] = [];
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const split = splitRowReader((row) => {
      const id = (row as { id: string }).id;
      calls.push(id);
      return id === "a" ? "v1" : id === "b" ? rowPending : rowFailed(boom);
    });
    expect(split.value(a)).toBe("v1");
    expect(split.rowState(a)).toEqual({ status: "known" });
    expect(split.value(b)).toBeUndefined();
    expect(split.rowState(b)).toEqual({ status: "loading" });
    expect(split.rowState(c)).toEqual({ status: "error", error: boom });
    expect(split.value(c)).toBeUndefined();
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("a known null stays a known null", () => {
    const split = splitRowReader(() => null);
    expect(split.value({})).toBeNull();
    expect(split.rowState({})).toEqual({ status: "known" });
  });
});

describe("partitionKnownRows", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const states: Record<string, ReturnType<typeof splitRowReader>> = {
    release: splitRowReader((row) =>
      (row as { id: string }).id === "b" ? rowPending : "ready",
    ),
  };
  const release = {
    id: "release",
    label: "Release",
    rowState: states.release!.rowState,
  };

  it("keeps rows not known for a laid-out-by field out of the layout", () => {
    const { laidOut, notKnown } = partitionKnownRows(rows, [release]);
    expect(laidOut).toEqual([rows[0], rows[2]]);
    expect(notKnown).toEqual([
      {
        row: rows[1],
        field: { id: "release", label: "Release" },
        state: { status: "loading" },
      },
    ]);
  });

  it("hands the same rows back when no laid-out-by field reads per row", () => {
    const { laidOut, notKnown } = partitionKnownRows(rows, [
      { id: "title", label: "Title" },
    ]);
    expect(laidOut).toBe(rows);
    expect(notKnown).toEqual([]);
  });
});

describe("foldFieldRead", () => {
  it("loading with nothing held is pending; a failure over held data keeps it", () => {
    expect(foldFieldRead({ status: "loading", refetch })).toEqual({
      kind: "pending",
    });
    const stale: ResourceResult<number> = {
      status: "error",
      error: boom as never,
      stale: 3,
      refetch,
    };
    expect(foldFieldRead(stale)).toEqual({ kind: "known", data: 3 });
    expect(
      foldFieldRead({ status: "error", error: boom as never, refetch }),
    ).toEqual({ kind: "failed", readError: { error: boom, refetch } });
  });
});

describe("stampExtensionRead", () => {
  const fields = [{ id: "fav", label: "Fav", type: "bool" }];
  type Readers = Readonly<Record<string, (row: unknown) => FieldValue>>;

  it("stamps pending while the values load, and the reader once known", () => {
    const [pending] = stampExtensionRead<unknown>(fields, {
      status: "loading",
      refetch,
    });
    expect(pending!.pending).toBe(true);
    const ready: ResourceResult<Readers> = {
      status: "ready",
      data: { fav: () => true },
      refetch,
    };
    const [known] = stampExtensionRead<unknown>(fields, ready);
    expect(known!.pending).toBeUndefined();
    expect(known!.value?.({})).toBe(true);
  });

  it("refuses a field with no reader, and a reader with no field", () => {
    expect(() =>
      stampExtensionRead<unknown>(fields, {
        status: "ready",
        data: {},
        refetch,
      }),
    ).toThrow(/"fav" has no reader/);
    expect(() =>
      stampExtensionRead<unknown>(fields, {
        status: "ready",
        data: { fav: () => 1, ghost: () => 2 },
        refetch,
      }),
    ).toThrow(/"ghost", which it declares no field for/);
  });
});
