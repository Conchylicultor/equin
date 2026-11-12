import { useEffect, useRef, type ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  HostQueryErrorState,
  HostQueryFailureState,
  type HostQuerySubject,
} from "@plugins/apps/plugins/deploy/plugins/host-query/web";
import {
  siteMirrorStatus,
  siteMirrorSyncEndpoint,
  type MirrorOutcome,
  type SiteMirrorStatus,
} from "../../core";

const REDEPLOY =
  "Deploy it again (Deploy, at the top of this page) to sync it.";

/** Did the last pull end in a failure the line must show? */
function failed(outcome: MirrorOutcome): boolean {
  switch (outcome.kind) {
    case "synced":
    case "stopped":
      return false;
    case "fetch-failed":
      return outcome.failure.kind !== "not-found";
    case "refused":
    case "source-older":
      return true;
  }
}

/** A pull that ended without reaching the box's present, in words. */
function OutcomeFailure({
  outcome,
  subject,
}: {
  outcome: MirrorOutcome;
  subject: HostQuerySubject;
}): ReactNode {
  switch (outcome.kind) {
    case "synced":
    case "stopped":
      return null;
    case "fetch-failed":
      return outcome.failure.kind === "not-found" ? null : (
        <HostQueryFailureState failure={outcome.failure} subject={subject} />
      );
    case "refused": {
      const r = outcome.refusal;
      switch (r.kind) {
        case "unknown-set":
          return (
            <HostQueryErrorState
              title={`This site runs a release older than this app: it does not serve its ${subject.reading} to copy yet. ${REDEPLOY}`}
              detail={`The site answered unknown-set for "${r.setId}".`}
            />
          );
        case "unknown-table":
          return (
            <HostQueryErrorState
              title={`This site runs a release older than this app: it does not have every table of its ${subject.reading} this app copies. ${REDEPLOY}`}
              detail={`The site answered unknown-table for "${r.table}" of "${r.setId}".`}
            />
          );
        case "reconcile-required":
          return (
            <HostQueryErrorState
              title="The site asked for a full comparison, and the sync stopped there."
              detail={`reconcile-required below horizon ${r.horizon}`}
            />
          );
      }
      break;
    }
    case "source-older":
      return (
        <HostQueryErrorState
          title={`This site runs a release older than this app: its ${outcome.table} table lacks columns this app requires. ${REDEPLOY}`}
          detail={`Missing on the site: ${outcome.columns.join(", ")}`}
        />
      );
  }
}

/** What the copy is doing, as one line. */
function stateLine(row: SiteMirrorStatus | undefined): ReactNode {
  if (row === undefined) return "Not synced yet";
  const p = row.progress;
  if (row.phase === "copying" || (row.phase === "empty" && row.pending)) {
    if (p?.stage === "tables") {
      return `Copying… ${p.tablesDone} of ${p.total} tables · ${p.rows.toLocaleString()} rows`;
    }
    return p?.stage === "stream" ? "Copying… catching up" : "Copying…";
  }
  if (row.phase === "reconciling") {
    return p?.stage === "tables"
      ? `Reconciling… ${p.tablesDone} of ${p.total} tables`
      : "Reconciling…";
  }
  if (!row.copied) return row.pending ? "Syncing…" : "Not synced yet";
  return (
    <>
      Synced{" "}
      {row.lastSyncedAt === null ? (
        "—"
      ) : (
        <RelativeTime date={new Date(row.lastSyncedAt)} />
      )}
      {row.pending && " · syncing…"}
    </>
  );
}

/**
 * How fresh this computer's copy of a deployment's mirrored set is:
 * "Synced 12m ago · Sync now", "Copying… 2 of 4 tables" during the first
 * copy, "Reconciling…", and on a failed pull the failure (host-query's own
 * vocabulary; a site whose release predates the set: redeploy) above the
 * older data, which stays readable. Opening it asks the server for a pull
 * when the copy is missing or a few minutes old (`reason: "open"` — the
 * server decides, so the tab never reacts to the status it reads).
 */
export function MirrorFreshness({
  deploymentId,
  setId,
  subject,
}: {
  deploymentId: string;
  setId: string;
  /** What the set holds, in the failure sentences' words. */
  subject: HostQuerySubject;
}): ReactNode {
  const status = useLive(siteMirrorStatus, { deploymentId });
  const sync = useEndpointMutation(siteMirrorSyncEndpoint);
  const { mutate } = sync;
  const opened = useRef<string | null>(null);
  const openKey = `${deploymentId}:${setId}`;
  // Once per mount (and per deployment and set).
  useEffect(() => {
    if (opened.current === openKey) return;
    opened.current = openKey;
    mutate({ body: { deploymentId, setId, reason: "open" } });
  }, [openKey, deploymentId, setId, mutate]);

  switch (status.status) {
    case "loading":
      return <Loading variant="text" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject={`how fresh this site's ${subject.reading} copy is`}
          error={status.error}
          refetch={status.refetch}
        />
      );
    case "ready":
      return (
        <FreshnessLine
          row={status.data.find((r) => r.setId === setId)}
          subject={subject}
          syncing={sync.isPending}
          onSync={() =>
            mutate({ body: { deploymentId, setId, reason: "refresh" } })
          }
        />
      );
  }
}

function FreshnessLine({
  row,
  subject,
  syncing,
  onSync,
}: {
  row: SiteMirrorStatus | undefined;
  subject: HostQuerySubject;
  syncing: boolean;
  onSync: () => void;
}): ReactNode {
  const failure =
    row !== undefined &&
    !row.pending &&
    row.lastOutcome !== null &&
    failed(row.lastOutcome) ? (
      <OutcomeFailure outcome={row.lastOutcome} subject={subject} />
    ) : null;
  return (
    <Stack gap="xs">
      <Inline gap="xs">
        <Text variant="caption" tone="muted">
          {stateLine(row)}
          {failure !== null && row?.copied && row.lastSyncedAt !== null && (
            <>
              {" "}
              · showing data synced{" "}
              <RelativeTime date={new Date(row.lastSyncedAt)} />
            </>
          )}
        </Text>
        <Button
          variant="ghost"
          loading={syncing || row?.pending === true}
          onClick={onSync}
        >
          Sync now
        </Button>
      </Inline>
      {row?.runError != null && (
        <HostQueryErrorState
          title={`The last sync of this site's ${subject.reading} failed with an error.`}
          detail={row.runError}
        />
      )}
      {failure}
    </Stack>
  );
}
