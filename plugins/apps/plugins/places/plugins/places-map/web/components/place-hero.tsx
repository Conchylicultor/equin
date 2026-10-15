import { useRef, useState, type ReactNode } from "react";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { PlacePhoto } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placePhotoUrl } from "@plugins/apps/plugins/places/plugins/place-details/core";
import type { PlaceVisual } from "../internal/place-visual";

const prevIcon = symbol("chevron-left");
const nextIcon = symbol("chevron-right");
const photosIcon = symbol("photo-library");

/** Photos are fetched at twice the card's width, for a sharp hi-dpi strip. */
const PHOTO_FETCH_PX = 720;

/**
 * What tops the card: Google's photos when it has some, else the colour wash
 * (`photos: []` — a custom place, one Google no longer knows, or one without
 * photos), or a placeholder while a Google place's details are still loading
 * (`photos: "loading"`), so the hero never swaps from wash to photo.
 * `children` overlay its top-right corner (the close button).
 */
export function PlaceHero({
  photos,
  visual,
  children,
}: {
  photos: readonly PlacePhoto[] | "loading";
  visual: PlaceVisual;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={cn("relative", clipClasses({ axis: "both", fill: false }))}>
      {photos === "loading" ? (
        <Loading variant="block" className="h-52 rounded-none" />
      ) : photos.length > 0 ? (
        <PhotoStrip photos={photos} />
      ) : (
        <Wash visual={visual} />
      )}
      <Pin to="top-right" offset="sm" layer="float">
        {children}
      </Pin>
    </div>
  );
}

/**
 * The tag colours as a soft wash, with the place's own icon as a large faint
 * watermark — the hero of a place without photos. User colours: painted
 * through `style`.
 */
function Wash({ visual }: { visual: PlaceVisual }): ReactNode {
  const tint = (c: string, pct: number) =>
    `color-mix(in srgb, ${c} ${pct}%, white)`;
  const background =
    visual.colors.length > 1
      ? `linear-gradient(115deg, ${visual.colors.map((c) => tint(c, 34)).join(", ")})`
      : `linear-gradient(150deg, ${tint(visual.mainColor, 22)}, ${tint(visual.mainColor, 48)})`;
  return (
    <div className="relative h-32" style={{ background }}>
      <Pin
        to="top-right"
        offset="none"
        style={{ top: "-0.75rem", right: "-1rem" }}
      >
        <Icon
          icon={visual.icon}
          active
          style={{
            width: "9rem",
            height: "9rem",
            rotate: "-12deg",
            color: "rgb(255 255 255 / 0.45)",
          }}
        />
      </Pin>
    </div>
  );
}

/**
 * Google's photos as a swipeable strip (scroll-snap, one photo per view), with
 * "1 / n", previous / next on hover, and the shown photo's author — Google's
 * terms require crediting it, linked to the author's page when Google gives one.
 */
function PhotoStrip({ photos }: { photos: readonly PlacePhoto[] }): ReactNode {
  const strip = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);
  const show = (i: number) =>
    revealElement(strip.current?.querySelectorAll("img")[i], {
      behavior: "smooth",
      inline: "start",
      scope: "nearest",
    });
  const author = photos[index]?.authors[0];
  return (
    <div className={cn(hoverRevealGroup, "relative h-52")}>
      <Scroll
        ref={strip}
        axis="x"
        hideScrollbar
        className="h-full snap-x snap-mandatory"
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        <Line className="h-full">
          {photos.map((p, i) => (
            <img
              key={p.name}
              src={placePhotoUrl(p.name, PHOTO_FETCH_PX)}
              alt=""
              loading={i === 0 ? "eager" : "lazy"}
              className={cn(
                rigidClass(),
                "h-full w-full snap-start object-cover",
              )}
            />
          ))}
        </Line>
      </Scroll>
      {photos.length > 1 ? (
        <>
          <Pin to="top-left" offset="sm" layer="float">
            <Line className="gap-2xs rounded-full bg-black/45 px-xs py-2xs text-caption text-white backdrop-blur-sm">
              <Icon icon={photosIcon} className="size-3.5" />
              {`${index + 1} / ${photos.length}`}
            </Line>
          </Pin>
          {index > 0 ? (
            <Pin
              to="left"
              offset="sm"
              layer="float"
              className={hoverRevealTarget}
            >
              <IconButton
                icon={prevIcon}
                label="Previous photo"
                onClick={() => show(index - 1)}
                variant="floating"
                className="rounded-full"
              />
            </Pin>
          ) : null}
          {index < photos.length - 1 ? (
            <Pin
              to="right"
              offset="sm"
              layer="float"
              className={hoverRevealTarget}
            >
              <IconButton
                icon={nextIcon}
                label="Next photo"
                onClick={() => show(index + 1)}
                variant="floating"
                className="rounded-full"
              />
            </Pin>
          ) : null}
        </>
      ) : null}
      {author !== undefined ? (
        <Pin to="bottom-right" offset="sm" layer="float">
          <span className="text-caption text-white/90 drop-shadow">
            {author.uri !== undefined ? (
              <a
                href={author.uri}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                {author.name}
              </a>
            ) : (
              author.name
            )}
          </span>
        </Pin>
      ) : null}
    </div>
  );
}
