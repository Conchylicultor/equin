import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { attemptWork } from "@plugins/tasks/plugins/attempt-work/core";
import { convCommitsGraphPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const altRouteIcon = symbol("alt-route");
const publishIcon = symbol("publish");

export function CommitsChip() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  // No conversation row → no attempt to measure. Split rather than subscribe
  // with a placeholder id: the standing is read only once the attempt id is
  // known.
  if (!conversation) return null;
  return <AttemptCommitsChip attemptId={conversation.attemptId} />;
}

function AttemptCommitsChip({ attemptId }: { attemptId: string }) {
  // The attempt's standing is the ONE fact this chip shows — ahead/behind and the
  // push count both come from it, so there is a single subscription and nothing
  // for two resources to disagree about.
  const workResult = useLive(attemptWork, { attemptId });
  const { isOpen, toggle } = convCommitsGraphPane.useToggle({});

  if (workResult.status === "loading") return null;
  if (workResult.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        icon={altRouteIcon}
        subject="the branch standing"
        error={workResult.error}
        refetch={workResult.refetch}
      />
    );

  const work = workResult.data;
  // Nothing to measure ⇒ a determinate non-value. Show a muted `—` with the
  // reason as its tooltip — never a confident "0 ahead" about a branch nobody
  // measured.
  if (!work.resolved) {
    return (
      <UnmeasuredChip reason={work.reason} isOpen={isOpen} onToggle={toggle} />
    );
  }

  const { pending, landedPushes, ledgerPushes } = work.value;
  if (pending.kind === "no-branch") {
    return (
      <UnmeasuredChip
        reason="Branch no longer exists — nothing left to compare against main"
        isOpen={isOpen}
        onToggle={toggle}
      />
    );
  }
  if (pending.mergeBase === null) return null;

  const { ahead, behind, branch } = pending;
  // Git-measured first, ledger as corroboration only. A `pushes` row PROVES a push
  // happened, but its absence proves nothing (the ingest job lags), so the ledger
  // may only ever be ORed into a positive answer. The fallback still earns its
  // keep: commits from before the trailer era carry nothing to grep for, so the
  // ledger is the only place their pushes are visible.
  const pushCount = landedPushes || ledgerPushes;

  const parts = [
    `${ahead} ahead`,
    behind > 0 ? `${behind} behind main` : "main",
    pushCount > 0 ? `${pushCount} push${pushCount !== 1 ? "es" : ""}` : null,
  ].filter(Boolean);
  const title = branch ? `${branch}: ${parts.join(", ")}` : parts.join(", ");

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      tooltip={title}
      aria-label={title}
      aria-pressed={isOpen}
      onClick={toggle}
      className="gap-xs px-sm text-control-compact tabular-nums"
    >
      <Icon icon={altRouteIcon} />
      <span className="text-muted-foreground">↑</span>
      <span className="text-muted-foreground">{ahead}</span>
      {behind > 0 ? (
        <>
          <span className="text-muted-foreground">↓</span>
          <span className="text-warning">{behind}</span>
        </>
      ) : null}
      {pushCount > 0 ? (
        <>
          <span className="text-muted-foreground">·</span>
          <Icon
            icon={publishIcon}
            className={`size-3.5 ${behind > 0 ? "text-muted-foreground" : "text-success"}`}
          />
          <span
            className={behind > 0 ? "text-muted-foreground" : "text-success"}
          >
            {pushCount}
          </span>
        </>
      ) : null}
    </Button>
  );
}

/** The chip with no counts to show: a muted `—`, the reason as its tooltip. */
function UnmeasuredChip({
  reason,
  isOpen,
  onToggle,
}: {
  reason: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      tooltip={reason}
      aria-label={reason}
      aria-pressed={isOpen}
      onClick={onToggle}
      className="gap-xs px-sm text-control-compact tabular-nums"
    >
      <Icon icon={altRouteIcon} />
      <span className="text-muted-foreground">—</span>
    </Button>
  );
}
