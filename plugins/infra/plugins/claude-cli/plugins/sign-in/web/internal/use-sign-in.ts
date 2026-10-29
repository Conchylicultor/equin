import { useLive, useLiveMutation } from "@plugins/network/plugins/live/web";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import {
  cancelClaudeSignIn,
  claudeSignInFlow,
  startClaudeSignIn,
  submitClaudeSignInCode,
  type ClaudeSignInTarget,
} from "../../core";
import { markStartedHere } from "./started-here";

/**
 * The computer's sign-in, live — loading until the first frame; `unavailable`
 * under a host without the computer.
 */
export function useClaudeSignInFlow() {
  return useLive(claudeSignInFlow);
}

/** The sign-in's three actions, or why there are none here. */
export type ClaudeSignInActions =
  | { kind: "unavailable"; message: string }
  | {
      kind: "available";
      /** Start a sign-in (cancelling the one running); resolves to its run id once it runs. */
      start: (target: ClaudeSignInTarget) => Promise<string>;
      /** Hand the run `id` the code from the sign-in page. */
      submitCode: (id: string, code: string) => Promise<void>;
      /** Stop the run `id`, or dismiss its outcome. */
      cancel: (id: string) => void;
    };

export function useClaudeSignInActions(): ClaudeSignInActions {
  const availability = useMachineAvailability(startClaudeSignIn);
  const fetchEndpoint = useFetchEndpoint();
  const cancel = useLiveMutation(cancelClaudeSignIn);
  if (!availability.available)
    return { kind: "unavailable", message: availability.message };
  if (cancel.kind === "unavailable")
    throw new Error("Claude sign-in: endpoints disagree on the computer");
  return {
    kind: "available",
    start: async (target) => {
      const started = await fetchEndpoint(
        startClaudeSignIn,
        {},
        { body: { target } },
      );
      if (started.kind === "unavailable") throw new Error(started.message);
      markStartedHere(started.value.id);
      return started.value.id;
    },
    submitCode: async (id, code) => {
      const sent = await fetchEndpoint(
        submitClaudeSignInCode,
        {},
        { body: { id, code } },
      );
      if (sent.kind === "unavailable") throw new Error(sent.message);
    },
    cancel: (id) => cancel.mutate({ body: { id } }),
  };
}
