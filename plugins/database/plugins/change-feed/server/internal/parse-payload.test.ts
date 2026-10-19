import { describe, expect, test } from "bun:test";
import { parseLiveStatePayload, parseTxnEndPayload } from "./parse-payload";

describe("parseLiveStatePayload", () => {
  test("parses a scoped UPDATE with ids", () => {
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["a","b"]}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a", "b"],
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("parses an INSERT with ids", () => {
    expect(parseLiveStatePayload(`{"t":"tasks","op":"I","ids":["x"]}`)).toEqual(
      {
        table: "tasks",
        op: "I",
        ids: ["x"],
        xid: null,
        changedAt: null,
        keys: null,
        unchanged: null,
      },
    );
  });

  test("parses a DELETE", () => {
    expect(parseLiveStatePayload(`{"t":"tasks","op":"D","ids":["x"]}`)).toEqual(
      {
        table: "tasks",
        op: "D",
        ids: ["x"],
        xid: null,
        changedAt: null,
        keys: null,
        unchanged: null,
      },
    );
  });

  test("ids null → FULL-for-table", () => {
    expect(parseLiveStatePayload(`{"t":"tasks","op":"U","ids":null}`)).toEqual({
      table: "tasks",
      op: "U",
      ids: null,
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("missing ids → null", () => {
    expect(parseLiveStatePayload(`{"t":"tasks","op":"U"}`)).toEqual({
      table: "tasks",
      op: "U",
      ids: null,
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("empty ids array stays empty (consumer treats empty as FULL)", () => {
    expect(parseLiveStatePayload(`{"t":"tasks","op":"U","ids":[]}`)).toEqual({
      table: "tasks",
      op: "U",
      ids: [],
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("invalid JSON → null", () => {
    expect(parseLiveStatePayload("not json")).toBeNull();
    expect(parseLiveStatePayload("")).toBeNull();
  });

  test("non-object JSON → null", () => {
    expect(parseLiveStatePayload(`"a string"`)).toBeNull();
    expect(parseLiveStatePayload(`42`)).toBeNull();
    expect(parseLiveStatePayload(`null`)).toBeNull();
    expect(parseLiveStatePayload(`[1,2,3]`)).toBeNull();
  });

  test("missing/empty table → null", () => {
    expect(parseLiveStatePayload(`{"op":"U","ids":null}`)).toBeNull();
    expect(parseLiveStatePayload(`{"t":"","op":"U","ids":null}`)).toBeNull();
  });

  test("bad op → null", () => {
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"X","ids":null}`),
    ).toBeNull();
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"INSERT","ids":null}`),
    ).toBeNull();
    expect(parseLiveStatePayload(`{"t":"tasks","ids":null}`)).toBeNull();
  });

  test("`x` (source txid) parses when present; absent/malformed degrades to null tolerantly", () => {
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["a"],"x":"12345"}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a"],
      xid: "12345",
      changedAt: null,
      keys: null,
      unchanged: null,
    });
    // Over-cap re-emit shape: ids dropped, attribution kept.
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":null,"x":"12345"}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: null,
      xid: "12345",
      changedAt: null,
      keys: null,
      unchanged: null,
    });
    // Malformed `x` never rejects the change — only the attribution degrades.
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["a"],"x":42}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a"],
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["a"],"x":""}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a"],
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("`at` (the change's wall clock) parses when present; absent/malformed degrades to null", () => {
    expect(
      parseLiveStatePayload(
        `{"t":"tasks","op":"U","ids":["a"],"x":"1","at":1789915496002}`,
      ),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a"],
      xid: "1",
      changedAt: 1789915496002,
      keys: null,
      unchanged: null,
    });
    // A malformed `at` loses one latency sample, never the change.
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["a"],"at":"soon"}`),
    ).toEqual({
      table: "tasks",
      op: "U",
      ids: ["a"],
      xid: null,
      changedAt: null,
      keys: null,
      unchanged: null,
    });
  });

  test("ids present but wrong shape → null", () => {
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":[1,2]}`),
    ).toBeNull();
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":"x"}`),
    ).toBeNull();
    expect(
      parseLiveStatePayload(`{"t":"tasks","op":"U","ids":["ok",3]}`),
    ).toBeNull();
  });

  test("a routed table's key layout parses row-wise into columns, row-aligned", () => {
    expect(
      parseLiveStatePayload(
        JSON.stringify({
          t: "side",
          op: "U",
          ids: ["p1"],
          k: {
            c: ["host", "view"],
            r: [
              ["h1", "v"],
              ["h2", null],
            ],
          },
          u: ["host"],
          x: "9",
        }),
      ),
    ).toEqual({
      table: "side",
      op: "U",
      ids: ["p1"],
      xid: "9",
      changedAt: null,
      keys: { host: ["h1", "h2"], view: ["v", null] },
      unchanged: ["host"],
    });
  });

  test("an empty unchanged set is a known 'every compared column moved', distinct from null (nothing known)", () => {
    expect(
      parseLiveStatePayload(`{"t":"h","op":"U","ids":["a"],"k":null,"u":[]}`)
        ?.unchanged,
    ).toEqual([]);
    expect(
      parseLiveStatePayload(`{"t":"h","op":"U","ids":["a"],"u":null}`)
        ?.unchanged,
    ).toBeNull();
  });

  test("a malformed layout or unchanged set routes the change UNSCOPED — never dropped, reported", () => {
    for (const bad of [
      `{"t":"h","op":"U","ids":["a"],"k":[]}`,
      `{"t":"h","op":"U","ids":["a"],"k":{"c":[],"r":[]}}`,
      `{"t":"h","op":"U","ids":["a"],"k":{"c":["a","a"],"r":[]}}`,
      `{"t":"h","op":"U","ids":["a"],"k":{"c":["a"],"r":[["x","y"]]}}`,
      `{"t":"h","op":"U","ids":["a"],"k":{"c":["a"],"r":[[1]]}}`,
      `{"t":"h","op":"U","ids":["a"],"k":{"c":["a"],"r":"x"}}`,
      `{"t":"h","op":"U","ids":["a"],"u":"a"}`,
      `{"t":"h","op":"U","ids":["a"],"u":[1]}`,
    ]) {
      const reported: string[] = [];
      expect(parseLiveStatePayload(bad, (c) => reported.push(c.table))).toEqual(
        {
          table: "h",
          op: "U",
          ids: null,
          xid: null,
          changedAt: null,
          keys: null,
          unchanged: null,
        },
      );
      expect(reported).toEqual(["h"]);
    }
  });

  test("a well-formed layout is not reported", () => {
    const reported: string[] = [];
    parseLiveStatePayload(
      `{"t":"h","op":"U","ids":["a"],"k":{"c":["x"],"r":[["1"]]},"u":["x"]}`,
      (c) => reported.push(c.table),
    );
    expect(reported).toEqual([]);
  });
});

describe("parseTxnEndPayload", () => {
  test("parses the marker live_state_txn_end() emits", () => {
    expect(parseTxnEndPayload(`{"x":"123456","n":3}`)).toEqual({
      xid: "123456",
      n: 3,
    });
  });

  // Strict: the router releases a transaction on its end, so an end it cannot
  // read must never be taken for another one.
  test.each([
    ["not json", "nope"],
    ["an array", `["1",2]`],
    ["a numeric xid", `{"x":12,"n":1}`],
    ["an empty xid", `{"x":"","n":1}`],
    ["a non-digit xid", `{"x":"12a","n":1}`],
    ["a missing count", `{"x":"12"}`],
    ["a zero count", `{"x":"12","n":0}`],
    ["a fractional count", `{"x":"12","n":1.5}`],
    ["a string count", `{"x":"12","n":"1"}`],
    ["an extra field", `{"x":"12","n":1,"t":"tasks"}`],
  ])("rejects %s", (_label, raw) => {
    expect(parseTxnEndPayload(raw)).toBeNull();
  });
});
