import type { FocusEventHandler, KeyboardEventHandler, RefObject } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Row,
  type RowFocus,
} from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import type { PageData } from "@plugins/page/plugins/editor/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { usePageNavigation } from "./navigation";
import { usePageReferenceActions } from "./actions";
import { usePageReferenceDecoration } from "./decoration";
import { PageReferenceTrailing } from "./trailing";

/**
 * The row's activation where the host declared no navigation: it still has to
 * be a `<button>` (a void block's caret lands on its control through
 * `focusRef`), it just opens nothing.
 */
const INERT = (): void => undefined;

export interface PageReferenceRowProps {
  /** The referenced page. */
  pageId: string;
  /** The referenced page's own `data` — its title, icon and kind. */
  page: PageData;
  /** Glyph for a page with no icon of its own (default: the page glyph). */
  fallbackIcon?: IconRef;
  /** The editor's caret is on this row: `Row`'s `selected`, and the tint yields to it. */
  selected?: boolean;
  /**
   * The row heads a card whose frame paints the wash over it and its content:
   * the row drops its own FILL (washed twice, the title line would read as a
   * second, darker box) but keeps the rest of the tint (the `--scrim` a pinned
   * action cluster dissolves into is the same wash either way).
   */
  inCard?: boolean;
  focusRef?: RefObject<RowFocus | null>;
  onKeyDown?: KeyboardEventHandler;
  onFocus?: FocusEventHandler;
}

/**
 * THE row a reference to another page is drawn as — a sub-page in its parent's
 * flow, a link-to-page block — so every reference to one page looks the same:
 * its icon and title, opening it through the host's declared navigation, the
 * page's kind's `PageReference.Decoration` (an instructions page's wash and its
 * Global chip), the `PageReference.Trailing` facts, and the contributed hover
 * actions. A block owns only what is its own (its caret plumbing).
 */
export function PageReferenceRow({
  pageId,
  page,
  fallbackIcon,
  selected,
  inCard,
  focusRef,
  onKeyDown,
  onFocus,
}: PageReferenceRowProps) {
  const nav = usePageNavigation();
  const actions = usePageReferenceActions(pageId);
  const decoration = usePageReferenceDecoration(pageId, page);
  const tint =
    decoration && inCard
      ? cn(decoration.tint, "bg-transparent")
      : decoration?.tint;

  // A decoration's chip is information, so it reads at rest; the reference
  // actions are something you reach for, so they still appear on hover. Two
  // clusters, then: the row's own cluster turns persistent and carries the
  // chip, and the actions ride an inline `RowActions` beside it. Inline rather
  // than pinned: the pinned cluster overlays the row's trailing edge, which is
  // exactly where the chip sits. Rows with no chip keep the plain pinned
  // cluster.
  //
  // The chip is capped: `Row` keeps an always-visible cluster at its full
  // content width (`shrink-0`) and its title cell is `flex-1` from a zero
  // basis, so an uncapped chip would crush the page's own title to nothing.
  const chip = decoration?.chip ?? null;
  const trailing =
    chip === null ? (
      actions
    ) : (
      <Stack direction="row" gap="xs" align="center">
        <Stack
          direction="row"
          gap="none"
          align="center"
          className={cn(yieldClass("x"), "max-w-48")}
        >
          {chip}
        </Stack>
        {actions === null ? null : (
          <RowActions pin={null}>{actions}</RowActions>
        )}
      </Stack>
    );

  return (
    <Row
      focusRef={focusRef}
      selected={selected}
      // The decoration's wash — dropped while the caret is here, because
      // `selected` and a tint are both a row BACKGROUND and `Row` merges its
      // caller's class last: kept, the tint would erase the caret cue. Hover
      // still wins over it (a `hover:` variant outranks a plain utility).
      className={selected ? undefined : tint}
      // A link: ⌘/middle-click opens the page in a new browser tab, and
      // Enter/Space synthesize the plain click, which opens it in place.
      {...activationProps(nav?.open(pageId) ?? INERT)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      actions={trailing}
      actionsAlwaysVisible={chip !== null}
      icon={
        <Center as="span" className="text-muted-foreground size-4">
          <PageIcon
            icon={page.icon}
            fallback={fallbackIcon}
            className="size-4"
          />
        </Center>
      }
    >
      <Text className="font-medium underline-offset-2 hover:underline">
        {page.title || "Untitled"}
      </Text>
      {/* What other plugins say ABOUT the page (its tags, …), right after
          the title and always visible; the title truncates first. */}
      <PageReferenceTrailing pageId={pageId} />
    </Row>
  );
}
