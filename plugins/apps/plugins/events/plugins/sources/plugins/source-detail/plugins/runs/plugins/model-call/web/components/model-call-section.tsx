import type { ReactNode } from "react";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  ClaudeCliCallDetail,
  useClaudeCliCalls,
} from "@plugins/infra/plugins/claude-cli/web";
import { useEventSourceRun } from "@plugins/apps/plugins/events/plugins/events-core/web";

/**
 * The section is available even while the run is still loading: loading is not
 * emptiness, and a section that gated itself on data would flicker its whole
 * card in after the read (the `source-detail` house rule).
 */
export function useModelCallAvailable(): boolean {
  return true;
}

export function ModelCallSection({ runId }: { runId: string }): ReactNode {
  // The run's own `startedAt` is what lets the call log distinguish "never
  // called" from "called, then trimmed" — so the section reads the run rather
  // than asking with a bare correlation id and accepting a wrong answer.
  const row = useEventSourceRun(runId);
  const run = row.status === "ready" && row.found ? row.row : undefined;
  // Both reads gate the answer: asking before `startedAt` has landed would
  // report `none` for a run whose call merely aged out — so nothing is asked
  // (the read stays `loading`) until the run is in hand.
  const calls = useClaudeCliCalls(
    run === undefined
      ? null
      : { correlationId: runId, occurredAt: run.startedAt },
  );

  if (row.status === "error") {
    return <Placeholder tone="error">{row.error.message}</Placeholder>;
  }
  // Absent: the pane's own resolve turns this into its Not Found.
  if (row.status === "ready" && !row.found) return null;
  if (calls.status === "error") {
    return (
      <ResourceErrorInline
        error={calls.error}
        refetch={calls.refetch}
        variant="block"
        subject="the model calls"
      />
    );
  }
  if (calls.status === "loading") return <Loading variant="rows" />;

  const result = calls.data;

  // Every arm rendered explicitly. Collapsing two of them is exactly what the
  // discriminated result exists to prevent — "no model call" and "the log no
  // longer has it" are different facts about this run.
  switch (result.status) {
    case "calls":
      return (
        <Stack gap="md">
          {result.calls.map((call) => (
            // Each call gets its own surface so two of them read as two calls
            // rather than one long transcript; the detail block itself ships no
            // chrome, by contract.
            <Surface key={call.id} level="base">
              <Inset pad="sm">
                <ClaudeCliCallDetail call={call} />
              </Inset>
            </Surface>
          ))}
        </Stack>
      );
    case "none":
      return (
        <Placeholder>
          No model call was recorded for this run. That is the expected answer
          for a cheap unchanged run: the probe fingerprint matched, so
          extraction — and the model call it would have paid for — was
          deliberately skipped.
        </Placeholder>
      );
    case "not-retained":
      return (
        <Placeholder>
          The call log no longer retains this run&apos;s model call. The log
          keeps only the most recent calls made anywhere in the app, and this
          run is older than the oldest one still held.
        </Placeholder>
      );
  }
}
