import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  resourcesDebug,
  type ResourceDebug,
} from "@plugins/debug/plugins/read-set/core";

// Server-fed companion to the client `ResourcesSection`: the authoritative
// server view of every registered resource's fan-out (max per-pk subscriber
// count = how many tabs each delta hits) and loader frequency (calls/min, max
// single-call ms over the profiling window). The client section shows what THIS
// tab subscribes to; this one shows the whole server's delivery cost — together
// they answer "is a cheap loader being hammered, and how wide does it fan out?".
// Default-sorted by call-rate desc so the hottest loader is on top. Reads the
// `resources.debug` snapshot (owned by debug/read-set): measured on mount and
// on Refresh, never pushed.
//
// Composed from <Stack> rows + <Inline>, NOT a DataTable: the pane is a single
// flowing scroll column shared by every section, and DataTable pins its header
// to that shared scroll container — which overlaps the sections above it. Flow
// rows compose correctly here.

function maxFanOut(subCounts: Record<string, number>): number {
  const values = Object.values(subCounts);
  return values.length === 0 ? 0 : Math.max(...values);
}

export function ServerResourcesSection(): ReactElement {
  const result = useLive(resourcesDebug);

  return (
    <Stack as="section" gap="sm">
      <Stack direction="row" align="center" gap="sm">
        <Fill>
          <SectionLabel>
            Server resources{" "}
            {/* The count only; the loading / failed states render below. */}
            {matchResource(result, {
              loading: () => null,
              error: () => null,
              ready: (data) => (
                <span className="opacity-60">{data.resources.length}</span>
              ),
            })}
          </SectionLabel>
        </Fill>
        <Button variant="outline" onClick={() => result.refresh()}>
          Refresh
        </Button>
      </Stack>
      {result.status === "loading" ? (
        <Loading />
      ) : result.status === "error" ? (
        <ResourceErrorInline
          variant="inline"
          subject="server resources"
          error={result.error}
          refetch={result.refetch}
        />
      ) : (
        <ServerResourceRows resources={result.data.resources} />
      )}
    </Stack>
  );
}

function ServerResourceRows({
  resources,
}: {
  resources: ResourceDebug[];
}): ReactElement {
  const rows = useMemo(
    () =>
      [...resources].sort(
        (a, b) =>
          (b.loaderStats?.ratePerMin ?? 0) - (a.loaderStats?.ratePerMin ?? 0),
      ),
    [resources],
  );
  if (rows.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        No registered resources.
      </Text>
    );
  }
  return (
    <Stack gap="2xs">
      {rows.map((r) => (
        <ServerResourceRow key={r.key} r={r} />
      ))}
    </Stack>
  );
}

function ServerResourceRow({ r }: { r: ResourceDebug }): ReactElement {
  const fanOut = maxFanOut(r.subCounts);
  return (
    <Stack direction="row" align="center" gap="sm">
      <Fill>
        <Text variant="caption">{r.key}</Text>
      </Fill>
      <Stack as={Rigid} direction="row" align="center" gap="sm">
        <Inline gap="sm">
          <Stat label="subs" value={r.subscribers} />
          {fanOut > 1 ? (
            <Badge variant="warning">×{fanOut}</Badge>
          ) : (
            <Stat label="fan" value={`×${fanOut}`} />
          )}
          <Stat
            label="/min"
            value={r.loaderStats ? Math.round(r.loaderStats.ratePerMin) : "—"}
          />
          <Stat
            label="max ms"
            value={r.loaderStats ? Math.round(r.loaderStats.maxMs) : "—"}
          />
        </Inline>
      </Stack>
    </Stack>
  );
}

// One labeled stat: a muted value with a dimmer trailing unit label.
function Stat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}): ReactElement {
  return (
    <Text as="span" variant="caption" tone="muted">
      <span className="tabular-nums">{value}</span>
      <span className="opacity-50"> {label}</span>
    </Text>
  );
}
