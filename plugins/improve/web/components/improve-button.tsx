import {
  Button,
  ButtonGroup,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { Fragment, useSyncExternalStore } from "react";
import { TaskDraftPopover } from "@plugins/tasks/plugins/task-draft-form/web";
import {
  getImproveOpenState,
  setImproveOpen,
  subscribeImproveOpen,
} from "../internal/open-store";
import {
  IMPROVEMENTS_CATEGORY_ID,
  improveButtonAnchor,
  improvePanelAnchor,
  improveSendAnchor,
  improveSent,
} from "../../core";
import { emitHintSignal, useHintAnchor } from "@plugins/hints/web";
import { ImproveSlots } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

// The single four-point spark — `flare`, whose Lucide counterpart is
// `sparkle` — rather than `auto-awesome` (the cluster of three, Lucide
// `sparkles`), the app's canonical "agent" glyph: Improve is the bar's one
// labelled action, and the lone spark reads as it at the bar's size.
const sparkIcon = symbol("flare");

/** What the onboarding tour points at inside the open popover. */
const HINT_ANCHORS = { panel: improvePanelAnchor, send: improveSendAnchor };

/**
 * The Improve pill: the Improve button (opening the draft popover) joined with
 * every contributed `ImproveSlots.Segment` — companion actions that feed the
 * same draft, such as picking a UI element — as one split capsule. Every
 * segment is a ghost: a quiet bar button, no fill and no outline, so the pill
 * reads as one labelled action rather than a framed box inside the bar's own
 * capsule. Only the Improve label is in the text colour; the icons (its sparkle
 * and the companions) keep the bar's quieter tone, like its other icons, and
 * brighten on hover.
 */
export function ImproveButton() {
  const { open, insert } = useSyncExternalStore(
    subscribeImproveOpen,
    getImproveOpenState,
  );
  const segments = ImproveSlots.Segment.useContributions();
  const anchorRef = useHintAnchor(improveButtonAnchor);

  return (
    <ButtonGroup shape="pill">
      <TaskDraftPopover
        open={open}
        onOpenChange={setImproveOpen}
        trigger={
          <Button ref={anchorRef} variant="ghost" className="text-foreground">
            <Icon
              icon={sparkIcon}
              className="text-muted-foreground transition-colors group-hover/button:text-foreground group-aria-expanded/button:text-foreground"
            />
            Improve
          </Button>
        }
        tooltip="Improve"
        target={{ kind: "category", categoryId: IMPROVEMENTS_CATEGORY_ID }}
        insert={insert}
        heading="Improve this app"
        placeholder="What should be better here?"
        hintAnchors={HINT_ANCHORS}
        onSuccess={(taskIds) => emitHintSignal(improveSent, { taskIds })}
      />
      {segments.map((segment) => (
        <Fragment key={segment.id}>
          {renderIsolated(
            ImproveSlots.Segment,
            segment as unknown as Contribution,
            {},
          )}
        </Fragment>
      ))}
    </ButtonGroup>
  );
}
