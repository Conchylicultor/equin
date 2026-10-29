import { useEffect, useState } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  useClaudeSignInActions,
  useClaudeSignInFlow,
} from "../internal/use-sign-in";
import { ClaudeSignInPanel } from "./sign-in-flow";

/**
 * The run this form started, as the computer's flow shows it: null until its
 * first step arrives (the start's answer can beat the pushed frame), `gone`
 * once the flow has moved past it (cancelled, dismissed, replaced).
 */
function useOwnRun(id: string | null) {
  const result = useClaudeSignInFlow();
  const [seen, setSeen] = useState<string | null>(null);
  const flow = result.status === "ready" ? result.data : null;
  const mine =
    id !== null && flow !== null && flow.kind !== "idle" && flow.id === id
      ? flow
      : null;
  // Derived during render (React's "adjust state when a prop changes"): no
  // effect, no extra commit.
  if (mine && seen !== mine.id) setSeen(mine.id);
  if (mine) return mine;
  return id !== null && seen === id ? { kind: "gone" as const } : null;
}

/**
 * Sign in to another Claude account and add it: its name, then Claude's
 * sign-in in the browser — the token it hands back goes straight to the
 * accounts' secrets store, never shown. `onAdded` gets the new account's id;
 * `onClose` ends the form (Cancel, Close, or the run gone — replaced by
 * another sign-in started elsewhere).
 */
export function AddClaudeAccountSignIn({
  onAdded,
  onClose,
}: {
  onAdded: (accountId: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const actions = useClaudeSignInActions();
  const run = useOwnRun(runId);

  if (run?.kind === "done" && run.accountId === undefined)
    throw new Error(
      "Claude sign-in: a new account's run ended with no account",
    );
  const added = run?.kind === "done" ? run.accountId : undefined;
  const gone = run?.kind === "gone";
  // Each outcome reaches the host once, whatever its callbacks' identity.
  const reportAdded = useEventCallback(onAdded);
  const reportClosed = useEventCallback(onClose);
  useEffect(() => {
    if (added !== undefined) reportAdded(added);
    else if (gone) reportClosed();
  }, [added, gone, reportAdded, reportClosed]);

  if (actions.kind === "unavailable")
    return (
      <Text variant="caption" tone="muted">
        {actions.message}
      </Text>
    );
  if (run?.kind === "waiting" || run?.kind === "failed")
    return <ClaudeSignInPanel flow={run} onRestarted={setRunId} />;
  // Started: its first step (or, once added, the form closing) is on its way.
  if (runId !== null)
    return <Loading variant="spinner" label="Starting the sign-in…" />;
  const signIn = async () => {
    const target = { kind: "new-account", name: name.trim() } as const;
    setRunId(await actions.start(target));
  };
  return (
    <Surface level="sunken" className="rounded-md p-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <Line className="gap-xs">
          <Fill>
            <Input
              autoFocus
              placeholder="Account name, e.g. Personal"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Fill>
          <Button
            type="submit"
            disabled={!name.trim()}
            tooltip="Sign in with the account's Claude subscription"
            onClick={signIn}
          >
            Sign in
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </Line>
      </form>
    </Surface>
  );
}
