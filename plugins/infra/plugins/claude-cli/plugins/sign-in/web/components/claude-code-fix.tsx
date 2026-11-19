import {
  claudeCodeFix,
  claudeCodeProblem,
  recheckClaudeCode,
  type ClaudeCodeBlock,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { useClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useClaudeSignInActions } from "../internal/use-sign-in";
import { useOpenComputerFlow } from "./claude-code-sign-in";
import { ClaudeSignInButton } from "./sign-in-button";
import { ClaudeSignInPanel } from "./sign-in-flow";

const warningIcon = symbol("warning");

// A Claude Code block, drawn with its fix — where the problem shows, never a
// sentence pointing somewhere else: Sign in (the in-app flow, its run's panel
// in place while it is open) and Check again.

/** Check again — the user's own ask: it also drops a refusal Claude gave mid-turn. */
function CheckAgain() {
  const availability = useMachineAvailability(recheckClaudeCode);
  const fetchEndpoint = useFetchEndpoint();
  if (!availability.available) return null;
  return (
    <Button
      variant="ghost"
      onClick={async () => {
        await fetchEndpoint(
          recheckClaudeCode,
          {},
          { body: { trigger: "user" } },
        );
      }}
    >
      Check again
    </Button>
  );
}

/** The fix's controls: the open sign-in's panel, else Sign in and Check again. */
function FixActions({ block }: { block: ClaudeCodeBlock }) {
  const open = useOpenComputerFlow();
  const actions = useClaudeSignInActions();
  if (claudeCodeFix(block) === "sign-in" && open)
    return <ClaudeSignInPanel flow={open} />;
  return (
    <Line className="gap-xs">
      {claudeCodeFix(block) === "sign-in" && actions.kind === "available" ? (
        <ClaudeSignInButton
          onSignIn={async (method) => {
            await actions.start(method);
          }}
        />
      ) : null}
      <CheckAgain />
    </Line>
  );
}

/**
 * Why no agent can start, with its fix inline: what is wrong, then Sign in
 * (the three methods; the run's panel replaces it while it is open) and Check
 * again. The one way a surface shows a Claude Code block
 * (`useClaudeCodeLaunchBlock()` returns the block, never a sentence).
 */
export function ClaudeCodeFix({ block }: { block: ClaudeCodeBlock }) {
  return (
    <Surface level="sunken" className="rounded-md p-sm">
      <FixBody block={block} />
    </Surface>
  );
}

/** What is wrong, then its fix — inside whatever box holds it. */
function FixBody({ block }: { block: ClaudeCodeBlock }) {
  return (
    <Stack gap="sm">
      <Line className="gap-xs">
        <Icon icon={warningIcon} className="size-3.5 text-warning" />
        <Text variant="body">
          {claudeCodeProblem(block)}.{" "}
          {claudeCodeFix(block) === "sign-in"
            ? "Sign in to start agents."
            : "Check again to start agents."}
        </Text>
      </Line>
      <FixActions block={block} />
    </Stack>
  );
}

/**
 * {@link ClaudeCodeFix} where a launch control has no room for it: a Sign in
 * button standing in for Launch, opening the fix in a popover.
 */
export function ClaudeCodeFixButton({
  block,
  className,
}: {
  block: ClaudeCodeBlock;
  className?: string;
}) {
  return (
    <InlinePopover
      align="end"
      width="settings"
      tooltip={claudeCodeProblem(block)}
      trigger={
        <Button variant="outline" className={className}>
          <Icon icon={warningIcon} className="size-3.5 text-warning" />
          {claudeCodeFix(block) === "sign-in" ? "Sign in" : "Check Claude"}
        </Button>
      }
    >
      <FixBody block={block} />
    </InlinePopover>
  );
}

/**
 * The computer's current Claude Code block with its fix, or nothing while it
 * is fine (or not known yet) — for a record of a past failure (a turn Claude
 * refused the sign-in for) that offers the fix only while it still applies.
 */
export function ClaudeCodeFixWhileBlocked() {
  const block = foldResource(useClaudeCodeStatus(), {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: (s) => (s.kind === "ready" ? null : s),
  });
  return block ? <ClaudeCodeFix block={block} /> : null;
}
