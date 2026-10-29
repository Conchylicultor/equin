import { useEffect } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  useFetchEndpoint,
  useMachineAvailability,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { StepNote } from "@plugins/primitives/plugins/setup-steps/web";
import { claudeCodeProblem, recheckClaudeCode } from "../../core";
import { useClaudeCodeStatus } from "../internal/use-claude-code";
import { symbol } from "@plugins/ui/plugins/icons/core";

const refreshIcon = symbol("refresh");

function recheck(fetchEndpoint: FetchEndpoint): Promise<unknown> {
  return fetchEndpoint(recheckClaudeCode, {});
}

/**
 * The row's trailing control: ask the machine again now — disabled, with why as
 * its tooltip, under a host without the computer.
 */
export function ClaudeCodeActions() {
  const availability = useMachineAvailability(recheckClaudeCode);
  const fetchEndpoint = useFetchEndpoint();
  return availability.available ? (
    <IconButton
      icon={refreshIcon}
      label="Check again"
      onClick={() => recheck(fetchEndpoint)}
    />
  ) : (
    <IconButton
      icon={refreshIcon}
      label="Check again"
      tooltip={availability.message}
      disabled
    />
  );
}

/** The expanded row: Claude Code's own note — the fix is the row's Sign in. */
export function ClaudeCodeDetail() {
  const result = useClaudeCodeStatus();
  if (result.status === "loading") return null;
  if (result.status === "unavailable") {
    return <StepNote>{result.message}</StepNote>;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="Claude Code's status"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  const s = result.data;
  switch (s.kind) {
    case "ready":
      return (
        <StepNote>
          Every agent runs on this Claude Code
          {s.authMethod ? ` (signed in with ${s.authMethod})` : ""}.
        </StepNote>
      );
    case "unreadable":
      return <StepNote>{claudeCodeProblem(s)}</StepNote>;
    case "signed-out":
      // The fix is the row's own Sign in (`claude-cli/sign-in`): no command.
      return (
        <StepNote>
          Agents can't start until this computer is signed in to Claude.
        </StepNote>
      );
  }
}

/**
 * Checks again when the user comes back to the app while Claude Code is known
 * blocked. A sign-in can change outside the app (a token that expired, a
 * sign-in finished in another program), which announces nothing to this
 * machine's watchers — returning to the window is the moment the user expects
 * the app to have noticed. An event, not polling: nothing runs while the
 * window stays focused or while Claude Code is fine.
 */
export function RecheckOnReturn() {
  const result = useClaudeCodeStatus();
  const fetchEndpoint = useFetchEndpoint();
  // Only a KNOWN block re-checks on return; a status still loading, that
  // failed to load, or that no computer here can answer has nothing to
  // re-check against.
  const blocked = foldResource(result, {
    loading: () => false,
    error: () => false,
    unavailable: () => false,
    ready: (s) => s.kind !== "ready",
  });
  useEffect(() => {
    if (!blocked) return;
    const onFocus = () => {
      void recheck(fetchEndpoint);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [blocked, fetchEndpoint]);
  return null;
}
