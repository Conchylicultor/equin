import {
  Button,
  ButtonGroup,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { Fragment, useSyncExternalStore } from "react";
import { TaskDraftPopover } from "@plugins/tasks/plugins/task-draft-form/web";
import {
  getWishOpenState,
  setWishOpen,
  subscribeWishOpen,
} from "../internal/open-store";
import {
  WISHES_CATEGORY_ID,
  wishButtonAnchor,
  wishPanelAnchor,
  wishSendAnchor,
  wishSent,
} from "../../core";
import { emitHintSignal, useHintAnchor } from "@plugins/hints/web";
import { WishSlots } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

// The single four-point spark — `flare`, whose Lucide counterpart is
// `sparkle` — rather than `auto-awesome` (the cluster of three, Lucide
// `sparkles`), the app's canonical "agent" glyph: Wish is the bar's one
// labelled action, and the lone spark reads as it at the bar's size.
const sparkIcon = symbol("flare");

/** What the onboarding tour points at inside the open popover. */
const HINT_ANCHORS = { panel: wishPanelAnchor, send: wishSendAnchor };

const closeWish = () => setWishOpen(false);

/**
 * The Wish pill: the Wish button (opening the draft popover) joined with
 * every contributed `WishSlots.Segment` — companion actions that feed the
 * same draft, such as picking a UI element — as one split capsule. Every
 * segment is a ghost: a quiet bar button, no fill and no outline, so the pill
 * reads as one labelled action rather than a framed box inside the bar's own
 * capsule. Only the Wish label is in the text colour; the icons (its sparkle
 * and the companions) keep the bar's quieter tone, like its other icons, and
 * brighten on hover.
 */
export function WishButton() {
  const { open, insert } = useSyncExternalStore(
    subscribeWishOpen,
    getWishOpenState,
  );
  const segments = WishSlots.Segment.useContributions();
  const headerActions = WishSlots.HeaderAction.useContributions();
  const anchorRef = useHintAnchor(wishButtonAnchor);

  return (
    <ButtonGroup shape="pill">
      <TaskDraftPopover
        open={open}
        onOpenChange={setWishOpen}
        trigger={
          <Button ref={anchorRef} variant="ghost" className="text-foreground">
            <Icon
              icon={sparkIcon}
              className="text-muted-foreground transition-colors group-hover/button:text-foreground group-aria-expanded/button:text-foreground"
            />
            Wish
          </Button>
        }
        tooltip="Wish"
        target={{ kind: "category", categoryId: WISHES_CATEGORY_ID }}
        insert={insert}
        heading="Make a wish"
        headerActions={({ text }) =>
          headerActions.map((action) => (
            <Fragment key={action.id}>
              {renderIsolated(
                WishSlots.HeaderAction,
                action as unknown as Contribution,
                { close: closeWish, draft: text },
              )}
            </Fragment>
          ))
        }
        placeholder="Fix, change or build anything…"
        hintAnchors={HINT_ANCHORS}
        onSuccess={(taskIds) => emitHintSignal(wishSent, { taskIds })}
      />
      {segments.map((segment) => (
        <Fragment key={segment.id}>
          {renderIsolated(
            WishSlots.Segment,
            segment as unknown as Contribution,
            {},
          )}
        </Fragment>
      ))}
    </ButtonGroup>
  );
}
