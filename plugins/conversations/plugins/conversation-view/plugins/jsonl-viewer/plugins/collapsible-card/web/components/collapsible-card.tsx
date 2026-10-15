import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode } from "react";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { EventRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";

/**
 * Wrapper that makes header content interactive inside the card's click-through
 * trigger area. The whole header row sits over a full-bleed toggle button
 * (`pointer-events-none` content falls through to it), so anything that needs
 * its OWN click — a chip, a FilePath — must opt back in: `pointer-events-auto`
 * to receive events, `relative` to paint above the overlay. This is the single
 * sanctioned home for that idiom; never hand-roll the className pair, and never
 * place a raw interactive element in `label`/`aside` without it.
 */
export function CardHeaderAction({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("pointer-events-auto relative", className)}>
      {children}
    </span>
  );
}

export interface CollapsibleCardProps {
  /** Leading icon before the title. Rendered by the card inside the title
   *  group, so it inherits the canonical title size/color — pass the raw icon
   *  element (e.g. `<MdReplay className="size-3.5" />`), never a styled wrapper. */
  icon?: ReactNode;
  /** Title content after the optional icon. Natural case — never all-caps
   *  (jsonl-viewer rule). The card owns the title TYPOGRAPHY (house font + size);
   *  pass content only — `font-*`/`text-*` classes here are banned by lint
   *  (`collapsible-card/no-adhoc-card-title-font`). A semantic color accent
   *  (e.g. `text-primary-text` for the Instructions callout) is fine. Display content
   *  is click-through (toggles the card); interactive content placed here MUST
   *  be wrapped in `<CardHeaderAction>` so it keeps its own click. */
  label: ReactNode;
  /** Muted secondary suffix rendered after the title — a count, duration, or
   *  delta (`(3)`, `· 12ms`). The card paints it muted; pass the bare content
   *  including any separator, never the muted color class. */
  note?: ReactNode;
  /** Flexible, click-through descriptive text (a command, a one-line summary).
   *  Distinct from `label` (rigid identity) and `aside` (interactive): the card
   *  drops it into the single flexible cell where it absorbs slack and
   *  ellipsizes on one line. Stays click-through, so tapping it toggles the
   *  card. Pass bare content — the card paints it muted/dimmed. */
  summary?: ReactNode;
  /** Sibling affordance after the label — e.g. a clickable `<FilePath>`.
   *  Wrapped in `<CardHeaderAction>` automatically, so pass the raw element.
   *  There is deliberately no `filePath` convenience prop: this is chrome, and
   *  chrome must not depend on a domain component. `FilePath` reaches into
   *  `conversation-view` for pane navigation, so a shortcut here would close the
   *  cycle chrome → file-path → conversation-view → jsonl-viewer → chrome. Pass
   *  `aside={<FilePath filePath={…} />}` from the renderer, which owns the
   *  domain concern anyway. */
  aside?: ReactNode;
  /** Far-right sibling of the header row (e.g. running-dots). */
  trailing?: ReactNode;
  /** Destructive chrome override (tool failures). */
  error?: boolean;
  /** Open on first render. Default false. */
  defaultOpen?: boolean;
  className?: string;
  /** Collapsible body. */
  children?: ReactNode;
}

// One canonical chrome for every transcript card. Semantic accents live in the
// label content (e.g. a primary tool-name Badge), the `error` flag (destructive
// chrome), and the call-site `className` (the single Instructions callout) — never
// in a per-family tone. See research/2026-06-12-conversations-transcript-card-design-system.md.
// The fill and hairline are the palette's `threadCard` / `threadCardBorder`
// (defaults: `muted` at 20%, `border` at 50%), the pad the density group's
// `padThreadCard*` (default `md` × `sm`), the corners Card's own `rounded-card`.
const CARD_CHROME = "border-thread-card-border bg-thread-card";
const ERROR_CARD = "border-destructive/60 bg-destructive/5";
// font-sans pins one house font for every transcript card title — the header
// font is a property of the card chrome, not of each renderer. Without it,
// call sites drifted (some plain strings in sans, some font-mono spans).
// This is the Overlay's OUTER box: it owns only the positioning context (the
// `relative` Overlay emits), full width, and the inherited typography/color/hover.
// The single-line row layout itself lives on the <Line> INSIDE the Overlay —
// Overlay renders its children in a separate (non-flex) wrapper, so a flex/
// region-line class here would never reach the actual row of items.
const HEADER =
  "w-full font-sans text-2xs text-muted-foreground hover:text-foreground";

export function CollapsibleCard({
  icon,
  label,
  note,
  summary,
  aside,
  trailing,
  error,
  defaultOpen,
  className,
  children,
}: CollapsibleCardProps) {
  const { open, triggerProps, contentProps } = useCollapsible({ defaultOpen });
  const sideContent = aside ?? null;
  return (
    <Card
      controlSize="xs"
      className={cn(
        "group p-thread-card",
        error ? ERROR_CARD : CARD_CHROME,
        className,
      )}
    >
      {/* The toggle is a full-bleed layer sitting BEHIND the content via
          <Overlay behind clickThrough>, not a row sibling. The card draws no
          chevron: the whole row is the affordance, and the button's
          `aria-expanded` (from useCollapsible) and Expand / Collapse label
          carry the state. This decouples the
          click target (the whole header row) from the layout (the named-slot row
          below) — the two roles that, fused onto one <button>, pulled in
          opposite directions. Overlay paints the button under the content and
          makes the children click-through, so a tap anywhere on the strip toggles
          the card; the few interactive bits opt back in via CardHeaderAction
          (pointer-events-auto). Hovering anywhere in the row drives `t.hover` (it
          bubbles to this ancestor). */}
      <Overlay
        className={HEADER}
        clickThrough
        behind={
          <button
            {...triggerProps}
            aria-label={open ? "Collapse" : "Expand"}
            className="size-full transition-colors"
          />
        }
      >
        {/* <Line> is the actual single-line flex row (Overlay renders children
            in a non-flex wrapper, so the row mechanics must live here, not on
            HEADER). It carries region-line + the SingleLineProvider, so every
            leaf truncates instead of wrapping.

            The row is three structural zones: a RIGID identity group, the ONE
            flexible <Fill> cell, then RIGID trailing actions. The grow/shrink
            role lives ONLY on <Fill> — never on identity. (Putting flex-1 on the
            identity group was the old bug: with no flexible child it grew empty,
            opening a gap on short content; under a long sibling its min-w-0
            collapsed below the shrink-0 badge, overlapping it.) */}
        <Line className="gap-sm">
          {/* Zone 1 — rigid identity. shrink-0: never grows into slack, never
              collapses under a long neighbour, so the icon + tool badge stay
              intact. pointer-events-none lets clicks fall through to the overlay
              toggle beneath, so tapping the identity area collapses the card. */}
          <Stack
            as="span"
            direction="row"
            align="center"
            gap="xs"
            className={cn(rigidClass(), "pointer-events-none relative")}
          >
            {icon}
            {label}
            {note != null && (
              <span className="text-muted-foreground/60">{note}</span>
            )}
          </Stack>
          {/* Zone 2 — the single flexible cell. Always present: it absorbs all
              slack (so an empty one pushes the trailing actions flush-right, the
              ml-auto role) and is the ONE place truncation happens. Holds the
              click-through `summary` (ellipsizes via the ambient single-line
              <Text>) and/or the interactive `aside` (e.g. a FilePath with its own
              start-ellipsis). The aside takes `yieldClass` — NOT a second <Fill>:
              it must fall below its content width so the FilePath can
              start-ellipsize, but must not grow. Fill's basis-0 grow would hand
              the summary <Text> its full content width and squeeze the aside
              alone, instead of the two yielding together. */}
          <Fill>
            {/* Inner single-line row arranging summary + aside; <Fill> owns the
                grow/shrink, <Line> the row mechanics. */}
            <Line className="gap-sm">
              {summary != null && (
                <Text className="pointer-events-none opacity-70">
                  {summary}
                </Text>
              )}
              {sideContent && (
                <CardHeaderAction className={yieldClass("x")}>
                  {sideContent}
                </CardHeaderAction>
              )}
            </Line>
          </Fill>
          {/* Zone 3 — rigid trailing actions, flush-right (slack lives in Fill). */}
          {trailing && (
            <CardHeaderAction className={rigidClass()}>
              {trailing}
            </CardHeaderAction>
          )}
          <CardHeaderAction className={rigidClass()}>
            <EventRowActions />
          </CardHeaderAction>
        </Line>
      </Overlay>
      <FoldMotion {...contentProps}>
        {/* The offset rides inside the fold, so it tweens with the body. */}
        {/* eslint-disable-next-line spacing/no-adhoc-spacing -- top offset separating the collapsible body from the header inside the non-flex Card; lifting into Card padding would also pad the always-present header */}
        <div className="pt-2">{children}</div>
      </FoldMotion>
    </Card>
  );
}
