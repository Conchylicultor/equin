import { ApprovalLinks } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { useMemo, type ReactNode } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  deployRunHistory,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { DeployRunItemActions } from "../slots";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
// It IS `deployRunHistory`'s column scope (asserted at mount): the surface
// whose custom columns sort and filter the live window.
const DEPLOY_HISTORY_VIEW = defineDataView("deploy.deployment.history");

/**
 * The live source. "Which deploy shipped a1b2c3d" and "which one printed that
 * error" are the two things anyone reaches for, so the search box matches the
 * release, the commit and the message.
 */
const deployHistorySource = liveDataSource(deployRunHistory, {
  searchable: ["releaseRunId", "commitSha", "message"],
});

/**
 * Wall-clock milliseconds a run took, or how long the one in flight has been
 * going (read off this render's clock).
 */
function runMs(run: DeployRunRecord): number {
  const end = run.finishedAt ?? new Date();
  return Math.max(0, end.getTime() - run.startedAt.getTime());
}

// What the list says of the fields it DERIVES from `deployRunHistory` (the
// run record's own: label, type, options, filter domain — a live window, so
// nothing here may be derived from what happens to be loaded): how each cell
// reads and how wide it is. `deploymentId` is the scope every window states,
// `finishedAt` only sorts and filters — neither is a column.
const overrides = fieldOverrides(deployRunHistory, {
  status: { width: "12rem" },
  verb: { width: "8rem" },
  commitSha: { width: "8rem" },
  releaseRunId: { width: "16rem" },
  startedAt: { width: "8rem" },
  // Filterable and searchable; the row draws it as `detail`.
  message: { visible: false },
  deploymentId: { visible: false, filterable: false, groupable: false },
  finishedAt: { visible: false },
});

// The fields the list computes itself: `duration` has no column for the
// server to sort or filter, so it is neither (a live source offers a field
// only where its id or `column` names one); `phaseFailed` is the leg a failed
// `update` died on, carried on the row.
const extraFields: FieldDef<DeployRunRecord>[] = [
  // The CLI's own refusal, wrapped in full (this ledger exists partly so those
  // words survive the restart that used to eat them); a held run also gets the
  // links to where it is approved — an interactive control, not a value.
  {
    id: "detail",
    label: "Detail",
    type: "multiline-text",
    value: (r) => r.message,
    cell: (r) =>
      r.message || r.status === "needs-approval" ? (
        <Stack gap="2xs">
          {r.message && (
            <Text
              as="p"
              variant="caption"
              tone={r.status === "failed" ? "destructive" : "default"}
              className="whitespace-pre-wrap"
              title={r.message}
            >
              {r.message}
            </Text>
          )}
          {r.status === "needs-approval" && <ApprovalLinks run={r} />}
        </Stack>
      ) : null,
    width: "24rem",
  },
  {
    id: "phaseFailed",
    label: "Failed on",
    type: "enum",
    options: [
      { value: "converge", label: "Converge" },
      { value: "build", label: "Build" },
      { value: "ship", label: "Ship" },
    ],
    value: (r) => r.phaseFailed,
  },
  {
    id: "duration",
    label: "Took",
    type: "duration",
    value: runMs,
    width: "6rem",
  },
];

/**
 * **History** — every run ever launched for this deployment, from the durable
 * `deploy_runs` ledger.
 *
 * This is the section that makes *"what is live on this box, and what happened
 * before"* answerable after a reboot. The `deploy.runs` resource the sections
 * above render from is in-memory and empty after a restart — deliberately, it is
 * the live view — and this is the record beside it. So the pane no longer has to
 * caveat that it forgets.
 *
 * A live window over the ledger (`deployRunHistory`), scoped to this
 * deployment: a run opening, finishing or failing moves its row in place, and
 * the scroll pages past one window with no cap.
 */
export function DeployHistorySection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  // This deployment's runs: its scope, stated as data (never a filter the
  // user's Filter control could name or widen).
  const source = useMemo(
    () => deployHistorySource.scoped({ where: { deploymentId } }),
    [deploymentId],
  );

  return (
    <DataView<DeployRunRecord>
      storageKey={DEPLOY_HISTORY_VIEW}
      overrides={overrides}
      extraFields={extraFields}
      views={["list", "table"]}
      defaultView="list"
      recipe="ledger"
      itemActions={DeployRunItemActions}
      emptyState={<>Nothing has been deployed from here yet.</>}
      source={source}
    />
  );
}
