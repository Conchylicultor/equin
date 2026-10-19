import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The chrome a section wears — a closed pair, both painted here, so a stack's
 * sections are uniform whichever one their pane picked.
 *
 * - **`card`** (default) — a bordered, rounded `Card` with a leading chevron:
 *   the detail-pane look, where each section is an object of its own.
 * - **`inspector`** — a flat `<section>` closed by a 1px rule, its header a
 *   full-width row that fills on hover: the collapsed title is muted, the open
 *   one reads at full strength with its icon in the primary colour, and a quiet
 *   chevron sits at the row's far end (`SectionHeaderRow`'s
 *   `disclosure="end"`). For a
 *   side-panel inspector, where the sections are one continuous column and a
 *   card per section would box it into tiles. Its stack carries no gap and no
 *   inset: the rules divide it, and the headers' hover runs edge to edge.
 */
export type SectionCardVariant = "card" | "inspector";

export interface SectionCardProps {
  /** The chrome — see {@link SectionCardVariant}. Default `"card"`. */
  variant?: SectionCardVariant;
  /** The card's identity, and its click target: clicking it toggles the body. */
  title: string;
  /**
   * Leading icon, rendered between the chevron and the title. Pass the raw icon
   * element — the header row owns its size (`icon-auto`) and color.
   */
  icon?: ReactNode;
  /**
   * Header-right controls, laid out as a SIBLING of the title button (never a
   * nested interactive), so they keep their own click and stay reachable while
   * the card is collapsed. Rendered at `sm` control density — a header affordance
   * is chrome, not body content.
   */
  actions?: ReactNode;
  /** Controlled open state. Pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled initial state. Default: collapsed. */
  defaultOpen?: boolean;
  className?: string;
  /**
   * The collapsible body. Unmounted while collapsed.
   *
   * **Omit it** for a card whose whole content is one line: with no body there
   * is nothing to expand, so the card renders as a single STATIC row — no
   * chevron, no toggle — with the line's content in `actions`. The disclosure
   * affordance is therefore derived, never declared: a chevron exists exactly
   * when a body exists, so a card that opens onto nothing is unrepresentable.
   */
  children?: ReactNode;
}

/**
 * A titled, collapsible card: `Card` chrome around a `SectionHeaderRow` trigger
 * and a `CollapsibleContent` body. Collapsed, it is exactly one row — chevron,
 * icon, title, and whatever header actions the caller keeps reachable. With no
 * `children` it is that one row permanently, and drops the chevron with it.
 *
 * This is the sanctioned home for the "card whose title expands it" shape. It
 * exists so a stack of such cards is uniform BY CONSTRUCTION: the caller supplies
 * a title and a body, never the chrome, so no two cards can drift on padding,
 * radius, title typography, or chevron placement.
 *
 * The body is genuinely unmounted while collapsed (`CollapsibleContent`), so a
 * heavy panel costs nothing until opened. Anything that must keep running while
 * the card is shut (persistence, subscriptions) does not belong in the body —
 * lift it into a headless always-mounted component.
 */
export function SectionCard({
  variant = "card",
  title,
  icon,
  actions,
  open,
  onOpenChange,
  defaultOpen,
  className,
  children,
}: SectionCardProps) {
  // ONE header expression for both shapes, with `collapsible` DERIVED from the
  // body's presence — so the two can never drift into "a chevron over nothing"
  // or "a body with no way to open it".
  //
  // The row reads `open` / `toggle` / `contentId` off the Collapsible context,
  // so the chevron, the aria wiring, and the actions-as-sibling split (no
  // nested <button>) all come for free.
  const inspector = variant === "inspector";
  const header = (
    <SectionHeaderRow
      variant="title"
      // Inspector: square corners so the hover fill runs edge to edge, and a
      // tighter trailing pad so the header actions sit near the panel edge.
      // `py-md` over a body-text line is the same ~44px row the card has.
      className={
        inspector ? "rounded-none pl-lg pr-sm py-md" : "rounded-lg px-lg py-md"
      }
      disclosure={inspector ? "end" : "lead"}
      collapsible={children !== undefined}
      actions={
        actions ? (
          <ControlSizeProvider size="sm">{actions}</ControlSizeProvider>
        ) : undefined
      }
    >
      {inspector && open && icon ? (
        // The open section's icon takes the primary colour: the column's one
        // mark of which sections are showing their body.
        <span className="contents text-primary-text">{icon}</span>
      ) : (
        icon
      )}
      {title}
    </SectionHeaderRow>
  );

  // The frame is the only thing the two variants disagree on: the header and
  // the body rail below are shared, so they cannot drift apart.
  const frame = (content: ReactNode) =>
    inspector ? (
      <section className={cn("border-b border-border", className)}>
        {content}
      </section>
    ) : (
      <Card className={cn("rounded-lg p-none", className)}>{content}</Card>
    );

  if (children === undefined) {
    // One line, permanently: no Collapsible at all, so there is no open state
    // to persist and no body to unmount.
    return frame(header);
  }

  return frame(
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      defaultOpen={defaultOpen}
    >
      {header}
      {/* The body OPENS a rail region rather than merely padding: `rail-x-lg`
            applies the inset AND publishes it, so a descendant that follows the
            rail (a DataView's bands, a DataTable's rows) knows the card already
            paid and adds nothing. `px-lg` here would inset without publishing,
            and a follower would then guess — which is what the deleted
            `pane-gutter-flush` marker existed to correct, one wrapper at a time.
            Inline-only, so `pb-lg` stays: the block rhythm is unchanged. */}
      <CollapsibleContent className="rail-x-lg pb-lg">
        {children}
      </CollapsibleContent>
    </Collapsible>,
  );
}
