import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { dataPart, type CoverContent } from "../../core";

/**
 * The hover group a cover lifts with: put it on the element whose hover should
 * lift the cover (the whole gallery card), so pointing anywhere on the card —
 * its title included — raises the picture. The group's element also holds the
 * lift while it carries {@link coverHeldAttr} `="true"` — the card is the
 * surface's hovered row while the pointer is elsewhere (on its map pin).
 */
export const coverHoverGroup = "group/cover";

/** The data attribute that holds a {@link coverHoverGroup}'s hover look. */
export const coverHeldAttr = "data-cover-held";

/**
 * For a cover's DETAIL (a badge, a caption): shown on the card-sized cover,
 * hidden on a list row's thumbnail, where it would cover the picture. A cover
 * node never knows the size it is drawn at — the frame says so
 * (`data-cover-size`), and this class reads it.
 */
export const coverDetailClass =
  "group-data-[cover-size=thumb]/cover-frame:hidden";

export interface CoverFrameProps {
  /** `card` — the gallery card's picture (full width, 16/10, lifts on the
   *  card's hover); `thumb` — a list row's leading thumbnail. */
  size: "card" | "thumb";
  /** What the frame shows. `null` = a blank tinted frame — a covered surface's
   *  coverless row keeps the size every other row has. */
  content: CoverContent | null;
  /** Drawn over the picture (the cover's action chip, the primary button),
   *  inside the frame's corners. */
  children?: ReactNode;
  className?: string;
}

/**
 * The frame per size. The card's hover lift is the `coverLift` token
 * (`translate-cover-lift`, default the old `-translate-y-0.5`), motion-safe
 * only — under reduced motion the cover does not move. A held group
 * ({@link coverHeldAttr}) wears the same hover look.
 */
const FRAME: Record<CoverFrameProps["size"], string> = {
  card: cn(
    "aspect-[16/10] w-full rounded-cover shadow-cover",
    "transition-[translate,box-shadow] duration-200 ease-out",
    "motion-safe:group-hover/cover:translate-cover-lift group-hover/cover:shadow-cover-hover",
    "motion-safe:group-data-[cover-held=true]/cover:translate-cover-lift group-data-[cover-held=true]/cover:shadow-cover-hover",
    "motion-reduce:transition-none",
  ),
  thumb: "size-cover-thumb rounded-md",
};

/**
 * The picture itself on the card's hover: the `coverZoom` (motion-safe) and
 * `coverHoverFilter` tokens — `1` / `none` by default, so it does not change.
 * A thumbnail never zooms.
 */
const CONTENT: Record<CoverFrameProps["size"], string> = {
  card: cn(
    "transition-[scale,filter] duration-200 ease-out motion-reduce:transition-none",
    "motion-safe:group-hover/cover:scale-cover-zoom group-hover/cover:filter-cover-hover",
    "motion-safe:group-data-[cover-held=true]/cover:scale-cover-zoom group-data-[cover-held=true]/cover:filter-cover-hover",
  ),
  thumb: "",
};

const ICON_SIZE: Record<CoverFrameProps["size"], string> = {
  card: "size-10",
  thumb: "size-5",
};

/**
 * THE cover frame — one fixed shape per size, whatever the content: an image
 * (`object-cover`, decoded off the main thread), an icon on a tint, an
 * arbitrary node clipped to the frame, or nothing (the tint alone). The frame
 * owns the corners, its fill (`coverFill`), the hairline ring (drawn over the
 * content, `coverRing` ink, `coverRingHover` on the card's hover) and the
 * shadow, so a cover never paints its own chrome; `children` overlay it
 * (positioned against the frame). The card-sized frame is the `dv.cover` part.
 */
export function CoverFrame({
  size,
  content,
  children,
  className,
}: CoverFrameProps): ReactNode {
  return (
    <Clip
      data-cover-size={size}
      {...(size === "card" ? dataPart("dv.cover") : {})}
      className={cn(
        "group/cover-frame relative bg-cover-fill",
        FRAME[size],
        className,
      )}
    >
      {content === null ? null : content.kind === "image" ? (
        <img
          src={content.src}
          alt={content.alt ?? ""}
          decoding="async"
          loading="lazy"
          draggable={false}
          className={cn("block size-full object-cover", CONTENT[size])}
        />
      ) : content.kind === "icon" ? (
        <Center
          className={cn(
            "size-full bg-primary/10 text-primary-text",
            CONTENT[size],
          )}
        >
          <Icon icon={content.icon} className={ICON_SIZE[size]} />
        </Center>
      ) : (
        <Layer className={CONTENT[size]}>{content.node}</Layer>
      )}
      <Layer
        decorative
        // The hairline is drawn OVER the content (an inset ring on the frame
        // itself would paint under an opaque image), on the frame's own
        // corners — inherited, so a caller's radius (the soft table's thumb)
        // rounds the ring too.
        // On the card's hover it takes `coverRingHover` (default the resting
        // ink, so it does not change).
        className="rounded-inherit ring-1 ring-inset ring-cover-ring transition-colors group-hover/cover:ring-cover-ring-hover"
      />
      {children}
    </Clip>
  );
}
