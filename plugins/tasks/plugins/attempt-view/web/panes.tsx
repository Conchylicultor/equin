import { useLive } from "@plugins/network/plugins/live/web";
import {
  Pane,
  defineRoute,
  resolveRow,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { attemptRows } from "@plugins/tasks/plugins/tasks-core/core";
import { AttemptPane, AttemptsTitle } from "./components/attempt-pane";

function useResolveAttempt({
  attemptId,
}: {
  attemptId: string;
}): ResolveResult {
  return resolveRow(useLive(attemptRows, { id: attemptId }));
}

export const attemptPane = Pane.define({
  route: defineRoute({
    id: "attempt",
    segment: "a/:attemptId",
  }),
  app: agentManagerApp,
  component: AttemptPane,
  width: 320,
  useResolve: useResolveAttempt,
  // The header adds the task's conversation count beside the word.
  title: { useText: "Attempts", component: AttemptsTitle },
});
