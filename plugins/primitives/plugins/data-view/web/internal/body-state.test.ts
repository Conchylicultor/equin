/**
 * `resolveBodyState` — what a DataView body renders in place of its view. The
 * load-bearing case is the failed read: `readiness.status === "error"` renders
 * the error state, never the view (whose zero rows would render `emptyState`,
 * a claim that there is nothing here).
 */

import { describe, expect, test } from "bun:test";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import type { FieldDef, FilterNode } from "../../core";
import { fieldsReadByView, resolveBodyState } from "./body-state";
import {
  UnavailableFilterRuleError,
  UnavailableSortRuleError,
} from "./live-filter";

const refetch = () => Promise.resolve();
const failure = new ResourceError("loader-failed", "boom", null);
const NONE = { filter: [], fold: [] };
const DANGLING = { id: "r1", fieldId: "gone", operatorId: "is" };

describe("resolveBodyState", () => {
  test("a failed read renders the error state, not the view", () => {
    const state = resolveBodyState({
      readFields: [],
      unavailable: NONE,
      deferredComplete: true,
      server: null,
      readiness: { status: "error", error: failure, refetch },
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") throw new Error("unreachable");
    expect(state.error.error).toBe(failure);
    expect(state.error.refetch).toBe(refetch);
  });

  test("readiness loading → loading; ready → the view", () => {
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: null,
        readiness: { status: "loading" },
      }).kind,
    ).toBe("loading");
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: null,
        readiness: { status: "ready" },
      }).kind,
    ).toBe("view");
  });

  test("a filter rule not resolvable yet → loading, never every row", () => {
    // The in-memory filter drops an unresolved rule; while its plugin is still
    // loading, rendering would show the rows the view hides, then take them back.
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: { filter: [DANGLING], fold: [] },
        deferredComplete: false,
        server: null,
        readiness: { status: "ready" },
      }).kind,
    ).toBe("loading");
  });

  test("a filter rule that never resolves → the rule error, naming it", () => {
    const state = resolveBodyState({
      readFields: [],
      unavailable: { filter: [DANGLING], fold: [] },
      deferredComplete: true,
      server: null,
      readiness: { status: "ready" },
    });
    expect(state.kind).toBe("rule-error");
    if (state.kind !== "rule-error") throw new Error("unreachable");
    expect(state.error).toBeInstanceOf(UnavailableFilterRuleError);
    const error = state.error as UnavailableFilterRuleError;
    expect(error.tree).toBe("filter");
    expect(error.rules).toEqual([DANGLING]);
  });

  test("a fold rule that never resolves → the rule error on both paths", () => {
    const fold = { filter: [], fold: [DANGLING] };
    const inMemory = resolveBodyState({
      readFields: [],
      unavailable: fold,
      deferredComplete: true,
      server: null,
      readiness: { status: "ready" },
    });
    const live = resolveBodyState({
      readFields: [],
      unavailable: fold,
      deferredComplete: true,
      server: { loading: false, error: null, readError: null },
      readiness: undefined,
    });
    for (const state of [inMemory, live]) {
      expect(state.kind).toBe("rule-error");
      if (state.kind !== "rule-error") throw new Error("unreachable");
      expect((state.error as UnavailableFilterRuleError).tree).toBe("fold");
    }
    // …and loading on the live path too while the deferred tier is loading.
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: fold,
        deferredComplete: false,
        server: { loading: false, error: null, readError: null },
        readiness: undefined,
      }).kind,
    ).toBe("loading");
  });

  test("a live source's unavailable rule is the same rule-error arm", () => {
    for (const error of [
      new UnavailableFilterRuleError([DANGLING], "filter"),
      new UnavailableSortRuleError(["gone"]),
    ]) {
      const state = resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: { loading: false, error, readError: null },
        readiness: undefined,
      });
      expect(state).toEqual({ kind: "rule-error", error });
    }
  });

  test("a failed read outranks a rule error", () => {
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: { filter: [DANGLING], fold: [] },
        deferredComplete: true,
        server: null,
        readiness: { status: "error", error: failure, refetch },
      }).kind,
    ).toBe("error");
  });

  test("without readiness, the rows are the view", () => {
    expect(
      resolveBodyState({
        server: null,
        readiness: undefined,
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("view");
  });

  test("a live origin keeps its own error and loading", () => {
    const err = new Error("sql");
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: { loading: false, error: err, readError: null },
        readiness: { status: "loading" },
      }),
    ).toEqual({ kind: "server-error", error: err });
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: { loading: true, error: null, readError: null },
        readiness: undefined,
      }).kind,
    ).toBe("loading");
  });

  test("a server-ordered read that failed renders the read error, not a server error", () => {
    const readError = { status: "error" as const, error: failure, refetch };
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: { loading: false, error: null, readError },
        readiness: undefined,
      }),
    ).toEqual({ kind: "error", error: readError });
    // The query it could not form outranks it — nothing was read.
    const err = new Error("filter");
    expect(
      resolveBodyState({
        readFields: [],
        unavailable: NONE,
        deferredComplete: true,
        server: { loading: false, error: err, readError },
        readiness: undefined,
      }).kind,
    ).toBe("server-error");
  });
});

describe("a field the view is laid out by", () => {
  const known: FieldDef<unknown> = { id: "status", label: "Status" };
  const pending: FieldDef<unknown> = {
    id: "category",
    label: "Category",
    type: "enum",
    pending: true,
  };
  const failed: FieldDef<unknown> = {
    id: "category",
    label: "Category",
    type: "enum",
    readError: { error: new Error("set failed"), refetch },
  };

  test("pending → the body is loading, never the view (its rows would all bucket as unset)", () => {
    expect(
      resolveBodyState({
        server: null,
        readiness: { status: "ready" },
        readFields: [known, pending],
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("loading");
    expect(
      resolveBodyState({
        server: { loading: false, error: null, readError: null },
        readiness: undefined,
        readFields: [pending],
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("loading");
  });

  test("failed with nothing held → that failure, naming the field", () => {
    const state = resolveBodyState({
      server: null,
      readiness: { status: "ready" },
      readFields: [pending, failed],
      unavailable: NONE,
      deferredComplete: true,
    });
    expect(state).toEqual({
      kind: "field-error",
      field: "Category",
      error: failed.readError!.error,
      refetch,
    });
  });

  test("the rows' own failed read outranks a field's", () => {
    expect(
      resolveBodyState({
        server: null,
        readiness: { status: "error", error: failure, refetch },
        readFields: [failed],
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("error");
  });

  test("fieldsReadByView: the group-by, sort, filter and fold fields — nothing else", () => {
    const fields: FieldDef<unknown>[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
      { id: "unread", label: "Unread" },
    ];
    const rule = (fieldId: string): FilterNode => ({
      kind: "rule",
      id: `r-${fieldId}`,
      fieldId,
      operatorId: "eq",
    });
    const read = fieldsReadByView(
      fields,
      {
        groupBy: { fieldId: "a", groupingId: "value" },
        sort: [{ fieldId: "b", direction: "asc" }],
        filter: {
          kind: "group",
          id: "g",
          conjunction: "and",
          children: [
            {
              kind: "group",
              id: "g2",
              conjunction: "or",
              children: [rule("c")],
            },
            rule("missing"),
          ],
        },
      },
      {
        keep: {
          kind: "group",
          id: "k",
          conjunction: "and",
          children: [rule("d")],
        },
      },
    );
    expect(read.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
    expect(
      fieldsReadByView(fields, { sort: [], filter: null }, undefined),
    ).toEqual([]);
  });

  test("a fold not in effect (suspended by a search, or a view without fold lines) does not hold the body on its field", () => {
    // The stored view state folds by the pending field; the fold in effect is
    // `undefined` — nothing lays the rows out by it, so the body is the view.
    const fields: FieldDef<unknown>[] = [known, pending];
    const readFields = fieldsReadByView(
      fields,
      {
        groupBy: { fieldId: "status", groupingId: "value" },
        sort: [],
        filter: null,
      },
      undefined,
    );
    expect(readFields.map((f) => f.id)).toEqual(["status"]);
    expect(
      resolveBodyState({
        server: null,
        readiness: { status: "ready" },
        readFields,
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("view");
    // …while the same fold IN effect holds it.
    const folded = fieldsReadByView(
      fields,
      { sort: [], filter: null },
      {
        keep: {
          kind: "group",
          id: "k",
          conjunction: "and",
          children: [
            { kind: "rule", id: "r", fieldId: "category", operatorId: "eq" },
          ],
        },
      },
    );
    expect(
      resolveBodyState({
        server: null,
        readiness: { status: "ready" },
        readFields: folded,
        unavailable: NONE,
        deferredComplete: true,
      }).kind,
    ).toBe("loading");
  });
});
