import type { ReactNode } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { NotKnownRow } from "../internal/field-read";

/**
 * The pending tail under a view: the rows it cannot place yet because their
 * value of a field it is laid out by is read per row and has not answered
 * (`partitionKnownRows`) — counted while checking, and, for those that failed,
 * the failure with one Retry for all of them. Nothing when every row is known.
 * Never a stand-in: a row here is in no bucket and at no position until its
 * value lands, and then it joins the view.
 */
export function NotKnownRowsTail({
  rows,
}: {
  rows: readonly NotKnownRow[];
}): ReactNode {
  if (rows.length === 0) return null;
  const checking = rows.filter((r) => r.state.status === "loading");
  const failed = rows.flatMap((r) =>
    r.state.status === "error" ? [{ ...r, state: r.state }] : [],
  );
  const subject = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
  // The field, named when all of them wait on one.
  const labels = [...new Set(rows.map((r) => r.field.label))];
  const of = labels.length === 1 ? ` (${labels[0]})` : "";
  return (
    <Stack gap="xs" className="rail-follow" data-testid="not-known-rows-tail">
      {checking.length > 0 ? (
        <Loading
          variant="spinner"
          label={`Checking ${subject(checking.length)}${of}…`}
        />
      ) : null}
      {failed.length > 0 ? (
        <ResourceErrorInline
          variant="inline"
          error={failed[0]!.state.error}
          refetch={retryAll(failed.map((r) => r.state.refetch))}
          subject={`${subject(failed.length)}${of}`}
        />
      ) : null}
    </Stack>
  );
}

/** One Retry for every failed row that offers one; none when no row does. */
function retryAll(
  refetches: readonly ((() => Promise<void>) | undefined)[],
): (() => Promise<void>) | undefined {
  const all = refetches.filter(
    (r): r is () => Promise<void> => r !== undefined,
  );
  if (all.length === 0) return undefined;
  return async () => {
    await Promise.all(all.map((r) => r()));
  };
}
