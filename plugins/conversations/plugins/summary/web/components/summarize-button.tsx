import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { useLatestConversationSummary } from "../hooks";
import { PHASE_CLASSES, PHASE_LABEL } from "./phase-styles";
import { convSummaryPane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

export function SummarizeButton() {
  const { convId } = conversationPane.useParams();
  const latestResult = useLatestConversationSummary(convId);
  const { isOpen, toggle } = convSummaryPane.useToggle({});

  if (latestResult.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={autoAwesomeIcon}
        subject="the summary"
        error={latestResult.error}
        refetch={latestResult.refetch}
      />
    );
  }
  // Render disabled-neutral while loading — badge depends on data so we must
  // not flash the wrong (no-badge) state during the load window.
  if (latestResult.status === "loading") {
    return (
      <Button
        variant={isOpen ? "secondary" : "ghost"}

        disabled
        className="gap-xs text-caption"
        tooltip="Summary"
        aria-label="Summary"
        aria-pressed={isOpen}
      >
        <Icon icon={autoAwesomeIcon} className="size-3.5" />
        Summary
      </Button>
    );
  }

  const latest = latestResult.data;

  if (!latest) {
    return (
      <Button
        variant={isOpen ? "secondary" : "ghost"}

        onClick={toggle}
        className="gap-xs text-caption"
        tooltip="Summary"
        aria-label="Summary"
        aria-pressed={isOpen}
      >
        <Icon icon={autoAwesomeIcon} className="size-3.5" />
        Summary
      </Button>
    );
  }

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      onClick={toggle}
      className="gap-xs"
      tooltip={`Summary: ${PHASE_LABEL[latest.phase]}`}
      aria-label={`Summary: ${PHASE_LABEL[latest.phase]}`}
      aria-pressed={isOpen}
    >
      <Badge colorClass={PHASE_CLASSES[latest.phase]}>
        {PHASE_LABEL[latest.phase]}
      </Badge>
    </Button>
  );
}
