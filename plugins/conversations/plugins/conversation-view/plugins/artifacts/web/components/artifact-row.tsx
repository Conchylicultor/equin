import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  afterOpen,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  RELATION_LABEL,
  type ArtifactItem,
} from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { useCloseArtifacts } from "../internal/close-context";
import { RelationMarker } from "./relation-marker";

export interface ArtifactRowProps {
  /** The artifact, as the host merged it. Owns the relation and the timestamps. */
  item: ArtifactItem;
  /** What to call it — the kind resolves this (a prototype's name, a basename). */
  title: string;
  /** The kind's glyph. Every row of one kind shows the same one. */
  icon: IconRef;
  /**
   * What activating the row does — a `LinkTarget` for anything that navigates,
   * so ⌘/middle-click opens it in a new browser tab. Omit for an artifact that
   * has nowhere to go.
   */
  activation?: Activation;
  /**
   * Why this row cannot be opened, e.g. a packaged skill with no file on disk.
   * Replaces the default tooltip's second line and greys the row out.
   */
  inertReason?: string;
}

/**
 * One artifact, on one line: the kind's glyph, what it is called, and a mark
 * for what the conversation did to it.
 *
 * It IS a {@link Row} — the primitive whose whole subject is this shape — and
 * not a line container dressed up as one. That is what makes the glyph track
 * the words (`Row` sizes any bare `<svg>` in its leading slot from the row's own
 * type rung), the title a declared size rather than whatever the popover
 * happened to inherit, and the focus ring the same one every other row in the
 * app paints.
 *
 * Shared by every kind that lists rows, so a prototype line and a research line
 * cannot drift apart. A kind whose items want a different shape — thumbnails,
 * name chips — renders its own and reuses {@link RelationMarker} instead.
 *
 * A row the conversation only *looked at* is muted, which is the whole of the
 * "referenced" signal: no mark, quieter text.
 *
 * Activating a row also dismisses the popover it is in, so a kind cannot ship a
 * row that navigates and leaves the panel hanging over what it opened. A
 * ⌘/middle-click does not: it opens a browser tab and this one stays put.
 */
export function ArtifactRow({
  item,
  title,
  icon,
  activation,
  inertReason,
}: ArtifactRowProps) {
  const close = useCloseArtifacts();
  const referenced = item.relation === "referenced";
  const detail =
    inertReason ??
    `${RELATION_LABEL[item.relation]} · ${formatRelativeTime(new Date(item.lastAt))}`;

  return (
    <Row
      // No size class: the row sizes its leading glyph from its own type rung,
      // so the mark beside the words tracks them instead of being a number this
      // file picked once.
      icon={<Icon icon={icon} className="text-muted-foreground" />}
      // The picker density, which is what this popover is — and one step under
      // the panel's own header, so the list never out-shouts the thing naming
      // it. Measured against the mock: this lands the row on its 28px pitch and
      // the glyph on its ~11px of ink, where the default rung would run eight
      // pixels taller per row. `size` and the title's `variant` below are ONE
      // decision, because the glyph is sized from the ROW's rung — a title that
      // declared a different one would put the two back out of step.
      size="sm"
      disabled={inertReason !== undefined || activation === undefined}
      {...activationProps(activation && afterOpen(activation, close))}
      title={`${item.key}\n${detail}`}
    >
      <Fill>
        <Text variant="caption" tone={referenced ? "muted" : "default"}>
          {title}
        </Text>
      </Fill>
      {/*
        The mark stays in the row BODY, not in `actions`: it says what the
        conversation DID to this artifact, which is state to read rather than a
        control to press — and `actions` is revealed on hover, so a mark put
        there would vanish exactly when the reader is not pointing at the row.
      */}
      <RelationMarker relation={item.relation} />
    </Row>
  );
}
