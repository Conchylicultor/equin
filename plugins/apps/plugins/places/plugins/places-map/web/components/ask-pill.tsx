import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  StepLabel,
  useThreadProgress,
} from "@plugins/conversations/plugins/agent-thread/web";
import { placesPicks } from "@plugins/apps/plugins/places/plugins/ask/core";

const sonnetIcon = symbol("auto-awesome");
const RESULTS = [placesPicks];

/**
 * Ask Sonnet's run, in the search bar: while it works, a spinner and the step
 * it is on; once it answered, how many picks — with a dot until you have
 * looked. A click shows the thread's side card, or hides it — the pill
 * stays either way, filled while the card is shown.
 */
export function AskPill({
  conversationId,
  shown,
  onToggle,
}: {
  conversationId: string;
  shown: boolean;
  onToggle: () => void;
}) {
  const progress = useThreadProgress(conversationId, RESULTS);
  const p = progress.status === "ready" ? progress.data : null;
  return (
    <Button
      variant="ghost"
      shape="pill"
      className={cn(
        "max-w-64",
        shown
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "bg-primary/10 text-primary-text",
      )}
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={shown ? "Hide Sonnet's thread" : "Show Sonnet's thread"}
    >
      {p === null || p.state === "working" ? (
        <Spinner />
      ) : (
        <Icon icon={sonnetIcon} className="size-4" />
      )}
      <Text variant="caption">
        {p === null ? (
          "Sonnet"
        ) : p.state === "working" ? (
          p.currentStep === null ? (
            `step ${p.stepsDone + 1}`
          ) : (
            <>
              {`step ${p.stepsDone + 1} · `}
              <StepLabel step={{ event: p.currentStep }} />
            </>
          )
        ) : p.state === "waiting" ? (
          "Waiting for you"
        ) : p.state === "failed" ? (
          "Sonnet stopped"
        ) : p.resultCount === 0 ? (
          "No picks"
        ) : (
          `${p.resultCount} pick${p.resultCount === 1 ? "" : "s"}`
        )}
      </Text>
      {p !== null && p.unseen && !shown ? (
        <StatusDot colorClass="bg-primary" />
      ) : null}
    </Button>
  );
}
