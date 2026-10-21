import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { ClaudeCodeDetail } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rampClass } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { renderInlineChip } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import type { AgentProcesses } from "../../core";
import {
  agentsElsewhere,
  type ClaudeCodeRowInputs,
} from "../internal/claude-code-row";
import { useClaudeCodeRowInputs } from "../internal/use-claude-code-row";
import { ClaudeAccountsSection } from "./claude-accounts";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";

// The Claude Code row's expanded detail: the versions and the agents, one line
// each, then Claude Code's own note and where the other agents run. Collapsed,
// the row shows only its title and summary.

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
function VersionLines({ claude, sdk, agents }: ClaudeCodeRowInputs) {
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
        // A flex row drops a trailing space, so the gap separates the words.
        <Line key={e.namespace} className={rampClass("gap", "xs")}>
          <Rigid>
            <Text variant="caption" tone="muted">
              {plural(e.running, "agent")} in
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

/**
 * The expanded row: the Claude accounts, the versions and the agents, Claude
 * Code's own detail, then where the other agents run.
 */
export function ClaudeCodeRowDetail() {
  const result = useClaudeCodeRowInputs();
  // A minute's tick: a reached limit's reset counts down, and passes.
  const now = useNow(60_000);
  return (
    <Stack gap="sm">
      {result.status === "ready" ? (
        <ClaudeAccountsSection
          accounts={result.data.accounts}
          usage={result.data.usage}
          claude={result.data.claude}
          now={now}
        />
      ) : null}
      {/* Not loaded (or not readable here): the summary already says so. */}
      {result.status === "ready" ? <VersionLines {...result.data} /> : null}
      <ClaudeCodeDetail />
      {result.status === "ready" ? (
        <AgentsElsewhere agents={result.data.agents} />
      ) : null}
    </Stack>
  );
}
