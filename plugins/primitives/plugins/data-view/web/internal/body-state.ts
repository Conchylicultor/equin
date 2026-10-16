import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import type { FieldDef, FilterNode, FoldRule, ViewState } from "../../core";

/**
 * What the body renders in place of the active view, if anything — the one
 * precedence both data paths share:
 *
 *   server error > failed read > failed field > loading > pending field > the view.
 *
 * A server-ordered origin's `error` is the query it could not form or page
 * (`server-error`); its `readError` is the read itself failing with nothing to
 * show — the same `error` arm the in-memory path's `readiness` fails with, so
 * a live list and a resource-backed one render a failure alike (Retry, and
 * the reload a stale tab needs). Without a `readiness` the in-memory rows are
 * taken as ready (a static list). A failed read never reaches the view, whose
 * empty rows would claim "nothing here" (`emptyState`).
 *
 * `readFields` are the fields the view PARTITIONS, ORDERS or MATCHES rows by
 * (`fieldsReadByView`). One whose own values are not known yet
 * (`FieldDef.pending`) makes the body loading, and one whose values failed
 * with nothing held (`FieldDef.readError`) makes it that failure: grouping by
 * a field with no values would put every row in its unset bucket (an enum's
 * "None"), sorting would order by nothing and a filter would match nothing —
 * each a claim about the rows that then reverses.
 *
 * `rulesPending`: the view's filter names a field or operator that does not
 * resolve YET — the plugin contributing it is still in the deferred load
 * tier. The in-memory filter drops an unresolved rule (it keeps every row), so
 * rendering now would show rows the view hides, then take them back once the
 * plugin lands (measured: the Pages sidebar's Favorites listing every page,
 * then shrinking to the starred ones). Loading instead, like a pending field.
 */
export type BodyState =
  | { kind: "server-error"; error: Error }
  | { kind: "error"; error: Extract<ResourceReadiness, { status: "error" }> }
  | {
      kind: "field-error";
      field: string;
      error: Error;
      refetch?: () => Promise<void>;
    }
  | { kind: "loading" }
  | { kind: "view" };

export function resolveBodyState(input: {
  server: {
    loading: boolean;
    error: Error | null;
    readError: Extract<ResourceReadiness, { status: "error" }> | null;
  } | null;
  readiness: ResourceReadiness | undefined;
  readFields: readonly FieldDef<unknown>[];
  rulesPending: boolean;
}): BodyState {
  const { server, readiness, readFields, rulesPending } = input;
  const failedField = readFields.find((f) => f.readError !== undefined);
  const fieldFailure: BodyState | null =
    failedField?.readError !== undefined
      ? {
          kind: "field-error",
          field: failedField.label,
          error: failedField.readError.error,
          ...(failedField.readError.refetch !== undefined
            ? { refetch: failedField.readError.refetch }
            : {}),
        }
      : null;
  const fieldPending = readFields.some((f) => f.pending === true);
  if (server) {
    if (server.error) return { kind: "server-error", error: server.error };
    if (server.readError) return { kind: "error", error: server.readError };
    if (fieldFailure) return fieldFailure;
    return server.loading || fieldPending
      ? { kind: "loading" }
      : { kind: "view" };
  }
  if (readiness?.status === "error") return { kind: "error", error: readiness };
  if (fieldFailure) return fieldFailure;
  return readiness?.status === "loading" || fieldPending || rulesPending
    ? { kind: "loading" }
    : { kind: "view" };
}

/**
 * The fields a view state reads row values of to lay the rows out: its
 * group-by field, its sort fields, every field its filter rule names, and
 * every field the fold IN EFFECT names. The fold is a separate argument, not
 * read off the state: the stored `state.fold` is not the one applied while a
 * search is typed (suspended) or in a view that draws no fold lines (the
 * tree), and a field named only by a fold nothing applies must not hold the
 * body. Ids no field answers to are skipped (a dangling rule is the filter's
 * own concern). The search query is not a layout read: it runs over the
 * search accessor, which a contributed field opts out of (`filterable`).
 */
export function fieldsReadByView<TRow>(
  fields: readonly FieldDef<TRow>[],
  state: Pick<ViewState, "groupBy" | "sort" | "filter">,
  fold: FoldRule | undefined,
): FieldDef<TRow>[] {
  const ids = new Set<string>();
  if (state.groupBy) ids.add(state.groupBy.fieldId);
  for (const rule of state.sort) ids.add(rule.fieldId);
  const walk = (node: FilterNode | null | undefined): void => {
    if (!node) return;
    if (node.kind === "rule") ids.add(node.fieldId);
    else for (const child of node.children) walk(child);
  };
  walk(state.filter);
  walk(fold?.keep);
  return fields.filter((f) => ids.has(f.id));
}
