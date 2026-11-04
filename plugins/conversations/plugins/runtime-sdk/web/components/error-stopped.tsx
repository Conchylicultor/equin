import { useState, type ReactElement } from "react";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  errorStoppedConversations,
  limitReached,
  resumeStoppedConversations,
  stopErrorLabel,
  USAGE_LIMIT_ERROR,
  weekRoom,
  type ClaudeUsageRead,
  type ErrorStoppedConversation,
  type ResumeStoppedResult,
} from "../../core";
import { formatResets } from "../internal/claude-usage";

// The conversations an API error stopped (a usage limit, a server error, a
// lost connection), in the Claude Code row: how many and of which kind, the
// list (each opens its conversation), and Resume all — one resume turn each,
// whose send restarts an agent a usage limit stopped on the account a launch
// picks now (`launchAccountId`).

const ERROR_STOPPED_VIEW = defineDataView("runtime-sdk.error-stopped");

const errorStoppedSource = liveDataSource(errorStoppedConversations, {
  surface: ERROR_STOPPED_VIEW,
  searchable: ["title"],
});

/**
 * `3 stopped · 2 usage limit · 1 server error` (one kind: `2 stopped · server
 * error`): the stops counted by kind, most first. Short, as it is the list's
 * toolbar title, sharing its row with the list's options.
 */
function stoppedPhrase(stopped: readonly ErrorStoppedConversation[]): string {
  const counts = new Map<string, number>();
  for (const c of stopped) {
    const label = stopErrorLabel(c.stopError);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const kinds =
    counts.size === 1
      ? [...counts.keys()]
      : [...counts]
          .sort((a, b) => b[1] - a[1])
          .map(([label, n]) => `${String(n)} ${label}`);
  return [`${String(stopped.length)} stopped`, ...kinds].join(" · ");
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

function failureOf(r: ResumeStoppedResult): { id: string; message: string }[] {
  return r.kind === "failed" ? [{ id: r.id, message: r.message }] : [];
}

export function ErrorStoppedBanner({
  stopped,
  launchAccountId,
  launchAccountName,
  usage,
  now,
}: {
  stopped: readonly ErrorStoppedConversation[];
  /** The account an agent restarted now runs on. */
  launchAccountId: string;
  launchAccountName: string;
  usage: ClaudeUsageRead;
  now: number;
}): ReactElement | null {
  const openPane = useOpenPane();
  const fetchEndpoint = useFetchEndpoint();
  const [failed, setFailed] = useState<{ id: string; message: string }[]>([]);
  if (stopped.length === 0) return null;
  const reading = usage.byAccount[launchAccountId];
  const reached = limitReached(reading, now);
  const room = weekRoom(reading, now);
  // Only a usage limit's resume depends on an account with room; any other
  // stop resumes on the agent's own.
  const limited = stopped.some((c) => c.stopError === USAGE_LIMIT_ERROR);
  const onlyLimited = stopped.every((c) => c.stopError === USAGE_LIMIT_ERROR);
  const resumeAll = async () => {
    const answer = await fetchEndpoint(
      resumeStoppedConversations,
      {},
      { body: { ids: stopped.map((c) => c.id) } },
    );
    if (answer.kind === "unavailable") {
      setFailed([{ id: "all", message: answer.message }]);
      return;
    }
    setFailed(answer.value.results.flatMap(failureOf));
  };
  return (
    // The card's tint is opaque and republished as `--chrome-mask`, so the
    // list's toolbar band (masked with it) is the card's colour, not a strip
    // of the surface under it. `--tint-under` holds that surface's mask, read
    // one element up: a property cannot mix in its own inherited value.
    <div className="[--tint-under:var(--chrome-mask)]">
      <Stack
        gap="xs"
        className="rounded-md border border-warning/30 bg-chrome-mask p-sm [--chrome-mask:color-mix(in_oklab,var(--warning)_10%,var(--tint-under))]"
      >
        <DataView<ErrorStoppedConversation>
          // The caption is the toolbar's title, so the list's options
          // trigger rides its row instead of a band of its own.
          title={stoppedPhrase(stopped)}
          density="compact"
          views={["list"]}
          source={errorStoppedSource}
          rowActivation={(c) =>
            openPane.to(conversationPane, { convId: c.id }, { mode: "push" })
          }
        />
        <Line>
          {limited && reached ? (
            <Text variant="caption" tone="muted">
              No account has room · {launchAccountName}{" "}
              {formatResets(reached.id, reached.resetsAt, now)}
            </Text>
          ) : null}
          <Fill />
          <Button
            disabled={onlyLimited && reached !== null}
            onClick={resumeAll}
          >
            Resume all
            {limited ? ` on ${launchAccountName}` : ""}
            {limited && room.kind === "known"
              ? ` · ${percent(room.left)} left`
              : ""}
          </Button>
        </Line>
        {failed.map((f) => (
          <Text key={f.id} variant="caption" tone="destructive">
            {f.id}: {f.message}
          </Text>
        ))}
      </Stack>
    </div>
  );
}
