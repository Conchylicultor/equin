import {
  closestOverlayPanel,
  Tooltip,
  TooltipCardContent,
  TooltipTrigger,
  usePinOnClick,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useRef, type ReactElement, type ReactNode } from "react";

import { HoverCardBody } from "./hover-card-body";

/** One facet of the subject — one it has, or (`off`) one it lacks. */
export interface HoverCardChip {
  label: string;
  /** The subject lacks this facet: drawn outlined, faint and struck through. */
  off?: boolean;
}

/** A headed list of short lines — the tasks a task waits on, say. */
export interface HoverCardList {
  label: string;
  items: readonly {
    /** Stable key; defaults to the text. */
    key?: string;
    text: string;
    /** A line of lesser standing (a reference not resolved yet), dimmed. */
    muted?: boolean;
  }[];
}

/** Where something stands on a path of steps: the path, the current step lit. */
export interface HoverCardSteps {
  items: readonly { id: string; label: string }[];
  /** Index of the current step in `items`; earlier ones read as done. */
  current: number;
  /** What the current step means, under the path. */
  caption?: ReactNode;
}

/**
 * What a hover card says, as data. Every part is optional but the title, and
 * each is laid out by the card itself — there is no free-form body, so a card
 * cannot be styled at its call site. A new kind of part is a new field here.
 */
export interface HoverCardContent {
  /** What the subject is called. */
  title: ReactNode;
  /** An identifier shown inline after the title, as code. */
  code?: string;
  /** What it is, in a sentence or two. */
  description?: ReactNode;
  /** Its facets, the ones it lacks included — so the reader sees both. */
  chips?: readonly HoverCardChip[];
  /** A path of steps, after the chips. */
  steps?: HoverCardSteps;
  /** Headed lists, in order, after the steps. */
  lists?: readonly HoverCardList[];
  /** Why it cannot be used right now. */
  notice?: string;
  /** Provenance parts (owner, counts…), joined with " · " in mono. */
  meta?: readonly string[];
}

export interface WithHoverCardProps {
  card: HoverCardContent;
  /**
   * What the card is placed against.
   *
   * - `trigger` (default): the trigger itself.
   * - `panel`: the floating panel the trigger sits in — a menu row's card
   *   hangs beside its MENU, its top level with the row, rather than
   *   covering the rows next to it. Throws when the trigger is in no panel.
   */
  beside?: "trigger" | "panel";
  /**
   * Preferred side; flips when there is no room. Default `top` beside a
   * trigger, `right` beside a panel.
   */
  side?: "top" | "right" | "bottom" | "left";
  /**
   * A click on the trigger pins the card open (a second click unpins it) —
   * for a trigger with no click action of its own, whose card IS what it
   * offers. See tooltip's `usePinOnClick`.
   */
  pinOnClick?: boolean;
  children: ReactElement;
}

/**
 * A hover card on `children`: the tooltip state machine (hover / focus, the
 * shared delay group, so moving down a menu's rows swaps the card at once),
 * drawn as the shared overlay panel at the `card` width.
 *
 * For a subject described in parts (a workspace, a commit). A one-line label
 * stays a `WithTooltip`, and a control's name + purpose a `TooltipDoc`.
 */
export function WithHoverCard({
  card,
  beside = "trigger",
  side,
  pinOnClick = false,
  children,
}: WithHoverCardProps) {
  const pin = usePinOnClick();
  const triggerRef = useRef<Element | null>(null);
  const anchor =
    beside === "panel"
      ? () => {
          const trigger = triggerRef.current;
          if (!trigger) return null;
          const panel = closestOverlayPanel(trigger);
          if (!panel)
            throw new Error(
              'WithHoverCard beside="panel": the trigger is in no overlay panel.',
            );
          // The panel's horizontal extent, the row's vertical one: placed to
          // the side with `align="start"`, the card's top meets the row's.
          return {
            contextElement: trigger,
            getBoundingClientRect: () => {
              const p = panel.getBoundingClientRect();
              const r = trigger.getBoundingClientRect();
              return DOMRect.fromRect({
                x: p.x,
                y: r.y,
                width: p.width,
                height: r.height,
              });
            },
          };
        }
      : undefined;
  return (
    <Tooltip {...(pinOnClick ? pin.root : {})}>
      <TooltipTrigger
        ref={(el) => {
          triggerRef.current = el;
        }}
        render={children}
        {...(pinOnClick ? pin.trigger : {})}
      />
      <TooltipCardContent
        anchor={anchor}
        side={side ?? (beside === "panel" ? "right" : "top")}
        align={beside === "panel" ? "start" : "center"}
      >
        <HoverCardBody card={card} />
      </TooltipCardContent>
    </Tooltip>
  );
}
