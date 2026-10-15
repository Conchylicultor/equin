import type { ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type {
  LiveArm,
  LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  DataViewSlots,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { TaskSubject } from "@plugins/tasks/plugins/task-subject/core";
import { InvestigateAction } from "./investigate-action";

/**
 * How one collection's (or union arm's) records are investigated — declared
 * ONCE beside the collection, drawn as a row action by every DataView listing
 * it, on exactly the rows `failed` picks.
 */
export interface InvestigateRegistration<Row> {
  /** The collection, or the union arm, whose failed records these are. */
  owner: LiveRowsCollection<Row> | LiveArm<Row, FieldsRecord, string>;
  /**
   * Whether this row is a failure someone must act on. On a union arm the
   * row may be another arm's: answer `false` for it.
   */
  failed: (row: Row) => boolean;
  /** What failed, in the copy ("build", "deploy"). */
  noun: string;
  /** The task category the investigation is filed under. */
  categoryId: string;
  /** The record the task is about — the dedupe key (`tasks/task-subject`). */
  subject: (row: Row) => TaskSubject;
  /** One or two lines on what the agent is told — the popover's description. */
  description: (row: Row) => ReactNode;
  /** The agent's brief: the facts the row holds, and where to dig for the rest. */
  brief: (row: Row, userText: string) => string;
}

/** The id a registration's action is keyed by: unique per owner within its list. */
function registrationId(owner: InvestigateRegistration<unknown>["owner"]) {
  return "kind" in owner ? `investigate:${owner.name}` : "investigate";
}

/**
 * `Investigate.Register({ owner, failed, … })` — the Investigate action on every
 * failed row of `owner`, in every list of it. The
 * `investigate:failures-registered` check holds every collection (and arm)
 * declaring a failure option (`variant: "destructive"`) to registering here.
 */
function register<Row>(
  registration: InvestigateRegistration<Row>,
): Contribution {
  const reg = registration as unknown as InvestigateRegistration<unknown>;
  function CollectionInvestigate({ row }: ItemActionProps<unknown>) {
    if (!reg.failed(row)) return null;
    return (
      <InvestigateAction
        presentation="row-action"
        noun={reg.noun}
        categoryId={reg.categoryId}
        subject={reg.subject(row)}
        description={reg.description(row)}
        brief={(userText) => reg.brief(row, userText)}
      />
    );
  }
  return DataViewSlots.CollectionItemAction({
    id: registrationId(reg.owner),
    owner: reg.owner,
    component: CollectionInvestigate,
  });
}

export const Investigate = { Register: register };
