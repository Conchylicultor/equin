import { useMemo, type ReactElement, type ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { useConfigResult } from "@plugins/config_v2/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { releaseHistory, type ReleaseRun } from "@plugins/release/core";
import { releaseDetailPane } from "../panes";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
// It IS `releaseHistory`'s column scope (asserted at mount): the surface
// whose custom columns sort and filter the live window.
const RELEASE_HISTORY_VIEW = defineDataView("studio.release.history");

// The live source: this namespace's release runs, scoped per composition by the
// pane. The search box matches these text columns (any of).
const releaseHistorySource = liveDataSource(releaseHistory, {
  searchable: ["composition", "target", "platform"],
});

function statusBadge(run: ReleaseRun): ReactNode {
  if (run.status === "running") {
    return (
      <Badge
        variant="warning"
        icon={<StatusDot colorClass="bg-warning animate-pulse" />}
      >
        Running
      </Badge>
    );
  }
  if (run.status === "succeeded") {
    return (
      <Badge variant="success" icon={<StatusDot colorClass="bg-success" />}>
        Succeeded
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      icon={<StatusDot colorClass="bg-destructive" />}
    >
      Failed
    </Badge>
  );
}

// How the derived fields present here (the collection declares their labels,
// types and filters; the status and target chips come from their options).
// `platform` is a free string set whose full enumeration lives server-side, so
// it stays a sortable text column rather than a client-derived (and thus
// partial) enum filter.
const overrides = fieldOverrides(releaseHistory, {
  target: {
    cell: (r) => <Badge variant="muted">{r.target}</Badge>,
    width: "9rem",
  },
  status: { cell: (r) => statusBadge(r), width: "8rem" },
  platform: {
    cell: (r) =>
      r.platform ? (
        <span className="font-mono text-muted-foreground">{r.platform}</span>
      ) : null,
    width: "10rem",
  },
  startedAt: {
    cell: (r) => (
      <span className="text-muted-foreground">
        <RelativeTime date={r.startedAt} />
      </span>
    ),
    width: "8rem",
  },
  finishedAt: {
    cell: (r) =>
      r.finishedAt ? (
        <span className="text-muted-foreground">
          <RelativeTime date={r.finishedAt} />
        </span>
      ) : null,
    width: "8rem",
  },
  composition: { visible: false },
});

export function ReleaseHistorySection({ id }: { id: string }): ReactNode {
  // The composition's name scopes the query, and it is not known until the
  // config is: loading is the list's own loading state (its toolbar already
  // up), a failed config read is its failure (with Retry), and an id the ready
  // config does not carry is a determinate answer — never a skeleton that
  // never resolves.
  const manifests = useConfigResult(compositionsConfig);
  return matchResource(manifests, {
    loading: () => <ReleaseHistory composition={null} />,
    ready: (config) => {
      const name = config.manifests.find((it) => it.id === id)?.name;
      return name === undefined ? (
        <Placeholder>No composition with id “{id}”.</Placeholder>
      ) : (
        <ReleaseHistory composition={name} />
      );
    },
  });
}

function ReleaseHistory({
  composition,
}: {
  /** `null`: the composition's name is still loading — the source awaits its scope. */
  composition: string | null;
}): ReactElement {
  const openPane = useOpenPane();
  const selectedRunId = releaseDetailPane.useRouteEntry()?.params.runId;
  // One composition's runs: its scope, stated as data (never a filter the
  // user's Filter control could name or widen).
  const source = useMemo(
    () =>
      composition === null
        ? releaseHistorySource.awaitingScope(["composition"])
        : releaseHistorySource.scoped({ where: { composition } }),
    [composition],
  );

  return (
    <DataView<ReleaseRun>
      storageKey={RELEASE_HISTORY_VIEW}
      overrides={overrides}
      views={["list", "table"]}
      defaultView="list"
      selectedRowId={selectedRunId}
      rowActivation={(r) =>
        openPane.to(releaseDetailPane, { runId: r.id }, { mode: "push" })
      }
      emptyState={<>No releases yet.</>}
      source={source}
    />
  );
}
