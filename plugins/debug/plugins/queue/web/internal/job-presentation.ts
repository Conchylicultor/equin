import {
  HOLD_CLASSES,
  HOLD_SPECS,
  JOB_STATES,
  jobRunsEntityRef,
  jobs,
  type JobRunOutcome,
} from "@plugins/infra/plugins/jobs/core";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { STATUS_META } from "./status";

const HOLD_OPTIONS: readonly LiveFieldOption[] = HOLD_CLASSES.map((hold) => ({
  value: hold,
  label: HOLD_SPECS[hold].label,
}));

const statusOptions = (
  statuses: readonly (keyof typeof STATUS_META)[],
): readonly LiveFieldOption[] =>
  statuses.map((value) => ({
    value,
    label: STATUS_META[value].label,
    variant: STATUS_META[value].badge,
  }));

const STATE_OPTIONS = statusOptions(JOB_STATES);
const OUTCOMES: readonly JobRunOutcome[] = ["succeeded", "failed", "suspended"];
const OUTCOME_OPTIONS = statusOptions(OUTCOMES);

function useHoldOptions(): LiveFieldOptionsRead {
  return HOLD_OPTIONS;
}

function useStateOptions(): LiveFieldOptionsRead {
  return STATE_OPTIONS;
}

function useOutcomeOptions(): LiveFieldOptionsRead {
  return OUTCOME_OPTIONS;
}

/** The Queue view's enum fields (`jobs`): their labels and badge tints, from `STATUS_META` / `HOLD_SPECS`. */
export const jobsPresentation = FieldPresentation.Register({
  owner: jobs,
  fields: {
    state: { useOptions: useStateOptions },
    hold: { useOptions: useHoldOptions },
  },
});

/** A recorded run's enum fields (`job_runs`, in every list of it): the same labels and tints. */
export const jobRunsPresentation = FieldPresentation.Register({
  owner: jobRunsEntityRef,
  fields: {
    outcome: { useOptions: useOutcomeOptions },
    hold: { useOptions: useHoldOptions },
  },
});
