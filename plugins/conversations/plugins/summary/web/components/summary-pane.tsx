import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEffect, useRef, useState } from "react";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import {
  useEndpointMutation,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { ConversationSummary } from "../../core";
import { generateConversationSummary } from "../../shared/endpoints";
import { useLatestConversationSummary } from "../hooks";
import { PHASE_CLASSES, PHASE_LABEL } from "./phase-styles";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

// Bound the spinner so a wedged Sonnet conversation eventually surfaces
// rather than hanging the chip forever. Matches the server-side reaper
// (CLEANUP_AFTER_MS in handle-generate.ts) so the two timers agree.
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

export function SummaryPane() {
  const convId = conversationPane.useRouteEntry()?.params.convId;
  // No conversation in the route → there is nothing to summarise, so nothing
  // to subscribe to. Split rather than subscribe with a placeholder id: the
  // hook only runs once the id is known.
  if (!convId) return null;
  return <ConversationSummaryPane convId={convId} />;
}

function ConversationSummaryPane({ convId }: { convId: string }) {
  const latestResult = useLatestConversationSummary(convId);

  return (
    <ResourceView resource={latestResult} fallback={<Loading />}>
      {(latest) => <SummaryPaneInner convId={convId} latest={latest} />}
    </ResourceView>
  );
}

function SummaryPaneInner({
  convId,
  latest,
}: {
  convId: string;
  latest: ConversationSummary | null;
}) {
  const toast = useToast();
  const generate = useEndpointMutation(generateConversationSummary, {
    onError: (err) =>
      toast({
        type: "summary",
        title: "Summarise failed",
        description: getEndpointErrorMessage(err),
        variant: "error",
      }),
  });

  const [pendingSince, setPendingSince] = useState<number | null>(null);

  // Resource updates with a summary newer than our pendingSince → success.
  const lastSeenIdRef = useRef<string | null>(latest?.id ?? null);
  useEffect(() => {
    if (!latest) return;
    if (lastSeenIdRef.current === latest.id) return;
    lastSeenIdRef.current = latest.id;
    if (pendingSince !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- optimistic-cleanup: clears the user-set optimistic pendingSince marker when server truth (a new latest.id pushed over live-state) confirms the summary arrived; this is a response to an external resource push, not a derivable render value.
      setPendingSince(null);
      // This toast is per-tab user-initiated (pendingSince gating), not a
      // cross-tab broadcast reaction — so it is not the reactive server I/O
      // `reactive-server-io/no-reactive-server-io` exists to catch. That rule
      // does not fire here only because `latest` reaches this component as a
      // prop (the `useLive` read lives in the parent), so keep the
      // reasoning even though there is no longer a directive to carry it.
      toast({
        type: "summary",
        title: "Summary ready",
        description: "A new conversation summary is available",
        variant: "success",
      });
    }
  }, [latest, pendingSince, toast]);

  // Timeout fallback so a stuck spawn surfaces.
  useEffect(() => {
    if (pendingSince === null) return;
    /* eslint-disable react-hooks/set-state-in-effect -- timeout watchdog state machine: a setTimeout drives the pending→idle transition after PENDING_TIMEOUT_MS so a wedged Sonnet spawn surfaces; the timer is the mechanism (cleared on re-run), not a derivable render value. */
    const remaining = pendingSince + PENDING_TIMEOUT_MS - Date.now();
    if (remaining <= 0) {
      setPendingSince(null);
      toast({
        type: "summary",
        title: "Summarisation timed out",
        description: "No summary returned in time",
        variant: "error",
      });
      return;
    }
    const t = setTimeout(() => {
      setPendingSince(null);
      toast({
        type: "summary",
        title: "Summarisation timed out",
        description: "No summary returned in time",
        variant: "error",
      });
    }, remaining);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => clearTimeout(t);
  }, [pendingSince, toast]);

  // Summarising launches a Sonnet conversation, which needs the computer: on
  // a host without it (the demo) the button is disabled and says why.
  async function onSummarize() {
    if (generate.kind === "unavailable" || pendingSince !== null) return;
    setPendingSince(Date.now());
    try {
      await generate.mutateAsync({ params: { conversationId: convId } });
    } catch (_err) {
      // onError handler fires the toast; reset pendingSince so the button re-enables after failure.
      setPendingSince(null);
    }
  }

  const isPending = pendingSince !== null;

  return (
    <Stack gap="md" className="p-md text-body">
      <Button
        variant="outline"
        onClick={onSummarize}
        loading={isPending}
        disabled={generate.kind === "unavailable"}
        tooltip={generate.kind === "unavailable" ? generate.message : undefined}
        className={cn("gap-xs", selfClass("start"), "text-caption")}
        aria-label={latest ? "Re-summarise" : "Summarise"}
      >
        <Icon icon={autoAwesomeIcon} className="size-3.5" />
        {latest ? "Re-summarise" : "Summarise"}
      </Button>

      {latest ? (
        <SummaryCard summary={latest} />
      ) : (
        <Text as="div" variant="caption" className="text-muted-foreground">
          No summary yet. Click Summarise to generate one.
        </Text>
      )}
    </Stack>
  );
}

function SummaryCard({ summary }: { summary: ConversationSummary }) {
  const generated = summary.generatedAt;
  return (
    <Stack gap="md" className="rounded-md border p-md">
      <Stack direction="row" gap="sm" align="center" justify="between">
        <Badge colorClass={PHASE_CLASSES[summary.phase]}>
          {PHASE_LABEL[summary.phase]}
        </Badge>
        <Text
          variant="caption"
          className="text-muted-foreground"
          title={generated.toISOString()}
        >
          {formatRelative(generated)} · {summary.turnCountAtGeneration} turns
        </Text>
      </Stack>

      {summary.phaseDetail && (
        <Section label="Detail">{summary.phaseDetail}</Section>
      )}
      <Section label="Next action">{summary.nextAction}</Section>
      {summary.flags && (
        <Section label="Flags" tone="warn">
          {summary.flags}
        </Section>
      )}
      {summary.notes && <Section label="Notes">{summary.notes}</Section>}
    </Stack>
  );
}

function Section({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className={`text-3xs uppercase tracking-wide ${
          tone === "warn" ? "text-warning" : "text-muted-foreground"
        }`}
      >
        {label}
      </div>
      <div className="whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function formatRelative(date: Date): string {
  const ms = Date.now() - date.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
