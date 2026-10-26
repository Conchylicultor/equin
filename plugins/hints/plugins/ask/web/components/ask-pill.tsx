import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  StepLabel,
  useThreadProgress,
} from "@plugins/conversations/plugins/agent-thread/web";
import { ASK_RESULTS } from "../internal/use-ask";
import { useRunQuestion } from "../internal/use-question";
import type { DragHandle } from "./ask-card";

const askIcon = symbol("forum");

/**
 * The minimized card's content, drawn in the host's `CardFrame` as a pill:
 * while the agent works, a spinner and the step it is on;
 * once it answered, the question — with a dot until you have looked. A click
 * opens the card again where it was; a press that travels drags it, like the
 * card's header (`useDragGesture` keeps the plain press a click). The label
 * takes the frame's fixed width and ellipsizes its tail.
 */
export function AskPill({
  conversationId,
  onOpen,
  drag,
}: {
  conversationId: string;
  onOpen: () => void;
  drag: DragHandle;
}) {
  const progress = useThreadProgress(conversationId, ASK_RESULTS);
  const question = useRunQuestion(conversationId);
  const p = progress.status === "ready" ? progress.data : null;
  const working = p === null || p.state === "working";
  return (
    <Button
      variant="ghost"
      shape="pill"
      className="w-full cursor-grab touch-none"
      onClick={onOpen}
      onPointerDown={drag}
      aria-label="Show Ask equin"
    >
      {working ? <Spinner /> : <Icon icon={askIcon} className="size-4" />}
      <Line as="span" className={fillClasses("x")}>
        <Text variant="caption">
          {p === null ? (
            "Ask equin"
          ) : p.state === "working" ? (
            p.currentStep === null ? (
              "Writing the answer…"
            ) : (
              <StepLabel step={{ event: p.currentStep }} />
            )
          ) : p.state === "waiting" ? (
            "Waiting for you"
          ) : p.state === "failed" ? (
            "Stopped"
          ) : (
            (question ?? "Ask equin")
          )}
        </Text>
      </Line>
      {p !== null && p.unseen ? <StatusDot colorClass="bg-primary" /> : null}
    </Button>
  );
}
