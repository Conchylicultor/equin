import type { ReactNode } from "react";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { activity } from "../../core";

// How the `activity` base fields present in every list of it — registered
// once against the collection (its rows are no one entity's). Each arm's own
// fields are presented by their owners: the entity's picked fields by the
// arm, an exposed field by its extension.

function when(date: Date): ReactNode {
  return (
    <span className="text-muted-foreground">
      <RelativeTime date={date} />
    </span>
  );
}

export const activityPresentation = FieldPresentation.Register({
  owner: activity,
  fields: {
    title: { width: "minmax(0,1fr)" },
    // The source field: its options (and its chip) are the registered arms.
    type: { width: "8rem" },
    updatedAt: { cell: when, width: "8rem" },
    createdAt: { cell: when, width: "8rem", visible: false },
  },
});
