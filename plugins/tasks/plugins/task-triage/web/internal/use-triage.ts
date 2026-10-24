import { useMemo } from "react";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { mapRow, useLiveRow } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  answerTriageEndpoint,
  parseTriageRead,
  runTriageEndpoint,
  taskTriageReads,
  type TaskTriageRow,
  type TriageRead,
} from "../../core";

// Stable (module-level), so the mapped read changes only with the row.
function toRead(row: TaskTriageRow | null): TriageRead | null {
  return row === null ? null : parseTriageRead(row);
}

/**
 * One task's triage, parsed: `null` once known to have none (Not triaged).
 * Not loaded yet stays the loading arm — never a "Not triaged" stand-in that
 * flips to a read a round trip later. A row breaking the state ⇄ fields
 * contract throws (`TriageRowError`), into the section's error boundary.
 */
export function useTriageRead(
  taskId: string,
): ResourceResult<TriageRead | null> {
  const result = useLiveRow(taskTriageReads, taskId);
  return useMemo(() => mapRow(result, toRead), [result]);
}

/** A failed request is already toasted by the endpoint layer; anything else stays loud. */
function swallowShown(err: unknown): void {
  if (err instanceof EndpointError) return;
  throw err;
}

/**
 * Run (or re-run) triage of the task: queued, then launched by the
 * dispatcher. The returned promise settles with the request, so a `Button`
 * pends on it; the card itself follows the live row.
 */
export function useRunTriage(taskId: string): () => Promise<void> {
  const run = useEndpointMutation(runTriageEndpoint);
  return () =>
    run.mutateAsync({ params: { taskId } }).then(() => undefined, swallowShown);
}

/** Pick (or, with `null`, clear) the person's answer to triage's question. */
export function useAnswerTriage(
  taskId: string,
): (answer: string | null) => Promise<void> {
  const answer = useEndpointMutation(answerTriageEndpoint);
  return (value) =>
    answer
      .mutateAsync({ params: { taskId }, body: { answer: value } })
      .then(() => undefined, swallowShown);
}
