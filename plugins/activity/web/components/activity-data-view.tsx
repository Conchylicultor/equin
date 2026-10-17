import type { ReactNode } from "react";
import {
  DataView,
  liveDataSource,
  type DataViewDensity,
} from "@plugins/primitives/plugins/data-view/web";
import { activity, type ActivityRow } from "../../core";
import { ACTIVITY_VIEW } from "../internal/view-id";

/** The live source: the `activity` union window, searched by title. */
const activitySource = liveDataSource(activity, { searchable: ["title"] });

export interface ActivityDataViewProps {
  /** The surface's heading, in its toolbar band. */
  title?: string;
  /** How much room the host gives it. */
  density?: DataViewDensity;
  /** The empty line — each host's own copy. */
  emptyState: ReactNode;
}

/**
 * **Recent activity** — tasks, conversations and pages in one list, newest
 * activity first. A plain `<DataView>` over the `activity` union window: its
 * fields are derived (the base fields from `activity`; each kind's from its
 * arm and its entity's exposures), and each row opens its own record
 * (`activityLinks`, per arm).
 */
export function ActivityDataView({
  title,
  density,
  emptyState,
}: ActivityDataViewProps): ReactNode {
  return (
    <DataView<ActivityRow>
      storageKey={ACTIVITY_VIEW}
      source={activitySource}
      views={["list", "table"]}
      defaultView="list"
      title={title}
      density={density}
      emptyState={emptyState}
    />
  );
}
