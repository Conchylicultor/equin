import { useMemo } from "react";
import {
  HOLD_CLASSES,
  HOLD_SPECS,
  jobRuns,
  jobsList,
  type JobRunRow,
  type JobsPayload,
} from "@plugins/infra/plugins/jobs/core";
import {
  FieldPresentation,
  useLive,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
} from "@plugins/primitives/plugins/live-state/web";
import { jobListRow } from "../../core";
import { PROBLEM_OPTIONS, STATUS_OPTIONS } from "./status";

const HOLD_OPTIONS: readonly LiveFieldOption[] = HOLD_CLASSES.map((hold) => ({
  value: hold,
  label: HOLD_SPECS[hold].label,
}));

function useStatusOptions(): LiveFieldOptionsRead {
  return STATUS_OPTIONS;
}

function useProblemOptions(): LiveFieldOptionsRead {
  return PROBLEM_OPTIONS;
}

function useHoldOptions(): LiveFieldOptionsRead {
  return HOLD_OPTIONS;
}

// The job names are read off the rows (a closed set per read): the queue's own
// registry is server-side. Read from the two sources themselves, whose results
// keep their identity until a push changes them.
function toJobNameOptions(d: {
  live: JobsPayload;
  runs: readonly JobRunRow[];
}): readonly LiveFieldOption[] {
  const names = new Set<string>();
  for (const job of d.live.rows) names.add(job.jobName);
  for (const run of d.runs) names.add(run.jobName);
  return [...names].sort().map((name) => ({ value: name, label: name }));
}

function useJobNameOptions(): LiveFieldOptionsRead {
  const live = useLive(jobsList);
  const runs = useLive(jobRuns);
  return useMemo(
    () => mapResource(combineResources({ live, runs }), toJobNameOptions),
    [live, runs],
  );
}

/** The Jobs list's enum fields: their options (the job names are read off the rows). */
export const jobListPresentation = FieldPresentation.Register({
  owner: jobListRow,
  fields: {
    status: { useOptions: useStatusOptions },
    problem: { useOptions: useProblemOptions },
    jobName: { useOptions: useJobNameOptions },
    hold: { useOptions: useHoldOptions },
  },
});
