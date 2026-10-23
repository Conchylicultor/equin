import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { CoverContent } from "../../core";

/**
 * The hover group a cover lifts with: put it on the element whose hover should
 * lift the cover (the whole gallery card), so pointing anywhere on the card —
 * its title included — raises the picture.
 */
export const coverHoverGroup = "group/cover";

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

const FRAME: Record<CoverFrameProps["size"], string> = {
  card: cn(
    "aspect-[16/10] w-full rounded-cover shadow-cover",
    "transition-[translate,box-shadow] duration-200 ease-out",
    "group-hover/cover:-translate-y-0.5 group-hover/cover:shadow-cover-hover",
    "motion-reduce:transition-none motion-reduce:group-hover/cover:translate-y-0",
  ),
  thumb: "size-cover-thumb rounded-md",
};

/** The corners alone, for the hairline drawn OVER the content (an inset ring on
 *  the frame itself would paint under an opaque image). */
const CORNERS: Record<CoverFrameProps["size"], string> = {
  card: "rounded-cover",
  thumb: "rounded-md",
};

const ICON_SIZE: Record<CoverFrameProps["size"], string> = {
  card: "size-10",
  thumb: "size-5",
};

/**
 * THE cover frame — one fixed shape per size, whatever the content: an image
 * (`object-cover`, decoded off the main thread), an icon on a tint, an
 * arbitrary node clipped to the frame, or nothing (the tint alone). The frame
 * owns the corners, the hairline ring (drawn over the content) and the shadow, so a cover never paints
 * its own chrome; `children` overlay it (positioned against the frame).
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
      className={cn(
        "group/cover-frame relative bg-muted",
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
          className="block size-full object-cover"
        />
      ) : content.kind === "icon" ? (
        <Center className="size-full bg-primary/10 text-primary-text">
          <Icon icon={content.icon} className={ICON_SIZE[size]} />
        </Center>
      ) : (
        <Layer>{content.node}</Layer>
      )}
      <Layer
        decorative
        className={cn("ring-1 ring-inset ring-border/60", CORNERS[size])}
      />
      {children}
    </Clip>
  );
}
