import { useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Backlinks } from "@plugins/page/plugins/links/web";
import {
  pageBacklinks,
  type BacklinkRow,
} from "@plugins/page/plugins/links/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PageHeaderPartProps } from "../slots";

const chevronIcon = symbol("chevron-right");
const linkIcon = symbol("link");

/** How many linking pages' icons the toggle stacks. */
const FACES = 3;

/**
 * "Linked from N pages", under the page title (`PageDetail.UnderTitle`): a
 * quiet toggle showing the first few linking pages' icons, which expands IN
 * PLACE into the full backlinks list — each row the source page, where it sits,
 * and the sentence that links here.
 *
 * Navigation is not passed down: the list renders inside the pane's own
 * `PageNavigationProvider`, the same seam the page's reference blocks read, so
 * a backlink row and a sub-page row open a page the same way by construction.
 *
 * Open state is local to the open page — it starts closed on every page, and
 * following a backlink to another page does not carry it along.
 */
export function BacklinksUnderTitle({ pageId }: PageHeaderPartProps) {
  const result = useLive(pageBacklinks, { pageId });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const { triggerControlProps, contentProps, chevronClassName } =
    useCollapsible({
      open: openFor === pageId,
      onOpenChange: (next) => setOpenFor(next ? pageId : null),
    });

  // Gated by `useHasBacklinks`, so this mounts only once the list is known
  // (non-empty) or failed. A failure keeps what it last knew; with nothing
  // known the toggle names no count and its expanded body renders the failure.
  const rows = foldResource(result, {
    loading: () => undefined,
    error: (_error, stale) => stale ?? null,
    ready: (data) => data,
  });
  if (rows === undefined) return null;
  const n = rows?.length ?? 0;

  return (
    <Stack gap="none">
      {/* The toggle is a header tool like the ones above the title: an `xs`
          ghost button, caption-sized and faint, hanging out by its own inline
          padding so its faces sit on the column's left edge. */}
      <Inline
        gap="none"
        style={{ marginLeft: "calc(-1 * var(--control-pad-xs))" }}
      >
        <ControlSizeProvider size="xs">
          <Button
            variant="ghost"
            className="text-caption font-normal text-faint-foreground"
            {...triggerControlProps}
          >
            {rows !== null && n > 0 && <Faces rows={rows.slice(0, FACES)} />}
            {n > 0
              ? `Linked from ${n} ${n === 1 ? "page" : "pages"}`
              : "Linked from"}
            <Icon
              icon={chevronIcon}
              className={cn("size-3.5", chevronClassName)}
            />
          </Button>
        </ControlSizeProvider>
      </Inline>
      {/* The list unfolds as a card on the page's own ground, widened past the
          column on both sides by the rows' own inline padding, so the rows'
          text sits just inside the column rather than a whole row inset in.
          A bleed the spacing ramp does not model, so it is an inline margin:
          the sideways one on the fold box (outside what the fold clips), the
          vertical ones inside it, so they tween with the card. */}
      <FoldMotion
        {...contentProps}
        aria-label="Pages linking here"
        style={{ marginInline: "calc(-1 * var(--pad-row-x))" }}
      >
        <div
          className="rounded-card border border-border bg-background p-xs"
          style={{ margin: "0.375rem 0 0.25rem" }}
        >
          <Backlinks documentId={pageId} />
        </div>
      </FoldMotion>
    </Stack>
  );
}

/** The first linking pages' icons, overlapping like a stack of faces. */
function Faces({ rows }: { rows: BacklinkRow[] }) {
  return (
    <Inline gap="none" aria-hidden>
      {rows.map((row, i) => (
        <Center
          key={row.id}
          as="span"
          className="size-5 rounded-md border border-background bg-muted"
          // One overlap the spacing ramp does not model (a negative step): each
          // face tucks under the one before it.
          style={i > 0 ? { marginLeft: "-0.25rem" } : undefined}
        >
          {/* A 12px glyph: the emoji box is the size over the 85% an
            `EmojiGlyph` draws its character at. */}
          <PageIcon
            icon={row.icon}
            fallback={linkIcon}
            className="size-[calc(12px/0.85)]"
          />
        </Center>
      ))}
    </Inline>
  );
}

/**
 * The contribution's `useAvailable` gate: a page with no inbound links shows
 * nothing under its title. While the value is still pending nothing is painted
 * either — no row is the one answer that claims nothing about the page, and it
 * appears once the backlinks settle non-empty. A failed read DOES paint the
 * toggle: its expanded body renders the failure with Retry.
 */
export function useHasBacklinks({ pageId }: PageHeaderPartProps): boolean {
  const result = useLive(pageBacklinks, { pageId });
  return foldResource(result, {
    loading: () => false,
    error: () => true,
    ready: (links) => links.length > 0,
  });
}
