import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { ClaudeCodeDetail } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { renderInlineChip } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import type { AgentProcesses } from "../../core";
import { agentsElsewhere } from "../internal/claude-code-row";
import { useClaudeCodeRowInputs } from "../internal/use-claude-code-row";

// The Claude Code row's glance (always shown while the report is open) and its
// expanded detail. The glance sits inside the row's click target, so it holds
// no controls: the chips opening the other worktrees' tasks are in the detail.

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function GlanceLine({ label, value }: { label: string; value: string }) {
  return (
    <Text variant="caption" tone="muted">
      {label} <span className="text-foreground">{value}</span>
    </Text>
  );
}

function agentsLine(agents: AgentProcesses): string {
  const here = agents.here === 0 ? "none here" : `${agents.here} here`;
  const elsewhere = agentsElsewhere(agents);
  return elsewhere === 0
    ? here
    : `${here} · ${elsewhere} in ${plural(agents.elsewhere.length, "other worktree")}`;
}

/** Claude Code, the Agent SDK and the agents, one line each. */
export function ClaudeCodeGlance() {
  const result = useClaudeCodeRowInputs();
  // Not loaded (or not readable here): the summary above already says so.
  if (result.status !== "ready") return null;
  const { claude, sdk, agents } = result.data;
  return (
    <Stack gap="none">
      {claude.kind === "ready" ? (
        <GlanceLine label="Claude Code" value={`v${claude.version}`} />
      ) : null}
      <GlanceLine
        label="Agent SDK"
        value={`${sdk.sdkVersion} · built for v${sdk.cliVersion}`}
      />
      <GlanceLine label="Agents" value={agentsLine(agents)} />
    </Stack>
  );
}

/** A namespace as its task's chip; main (or a name no chip claims) as text. */
function NamespaceLabel({ namespace }: { namespace: string }) {
  const chip =
    namespace === MAIN_WORKTREE_NAME ? null : renderInlineChip(namespace);
  return (
    chip ?? (
      <Text variant="caption">
        {namespace === MAIN_WORKTREE_NAME ? "main" : namespace}
      </Text>
    )
  );
}

/** Where the other agents run, each worktree as its task's chip. */
function AgentsElsewhere({ agents }: { agents: AgentProcesses }) {
  if (agents.elsewhere.length === 0) return null;
  return (
    <Stack gap="xs">
      <Text variant="caption" tone="muted">
        Agents in other worktrees
      </Text>
      {agents.elsewhere.map((e) => (
        <Line key={e.namespace}>
          <Rigid>
            <Text variant="caption" tone="muted">
              {plural(e.running, "agent")} in{" "}
            </Text>
          </Rigid>
          <Fill>
            <Clip>
              <NamespaceLabel namespace={e.namespace} />
            </Clip>
          </Fill>
        </Line>
      ))}
    </Stack>
  );
}

/** The expanded row: Claude Code's own detail, then where the other agents run. */
export function ClaudeCodeRowDetail() {
  const result = useClaudeCodeRowInputs();
  return (
    <Stack gap="sm">
      <ClaudeCodeDetail />
      {result.status === "ready" ? (
        <AgentsElsewhere agents={result.data.agents} />
      ) : null}
    </Stack>
  );
}
