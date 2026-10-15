import { useMemo, type ReactNode } from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  ClientFieldReaders,
  ClientFieldsResolverProps,
} from "@plugins/network/plugins/live/web";
import type { AppUsageSummaryRow } from "@plugins/apps-core/plugins/app-usage/core";
import { useAppUsageSummary } from "@plugins/apps-core/plugins/app-usage/web";
import type { appUsageFields } from "../../core";

type UsageFieldsRecord = NonNullable<(typeof appUsageFields)["__fields"]>;
/** The row the fields are resolved for: the `installedApp` kind's declared row. */
type AppRow = NonNullable<(typeof appUsageFields)["__row"]>;

/**
 * Resolves each app's usage stats from the summary. Always the same fields in
 * the same place: while the summary loads they are pending (no stand-in
 * zeros); an app absent from a READY summary was never used, so its counts
 * are 0 and its last-opened is empty.
 */
export function UsageResolver({
  render,
}: ClientFieldsResolverProps<AppRow, UsageFieldsRecord>): ReactNode {
  const result = useAppUsageSummary();
  const values = useMemo<
    ResourceResult<ClientFieldReaders<AppRow, UsageFieldsRecord>>
  >(
    () =>
      mapResource(result, (rows) => {
        const byApp = new Map<string, AppUsageSummaryRow>(
          rows.map((r) => [r.appId, r]),
        );
        const of = (a: AppRow): AppUsageSummaryRow | undefined =>
          byApp.get(a.id);
        return {
          focusedMs7d: (a) => of(a)?.focusedMs7d ?? 0,
          launches7d: (a) => of(a)?.launches7d ?? 0,
          focusedMsTotal: (a) => of(a)?.focusedMsTotal ?? 0,
          launchesTotal: (a) => of(a)?.launchesTotal ?? 0,
          lastOpenedAt: (a) => of(a)?.lastOpenedAt ?? null,
        };
      }),
    [result],
  );
  return render(values);
}
