import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  MARK_PENDING,
  MARK_SHADOW_PAD,
  escapeSvg,
  markIdPrefix,
  markShadow,
  markSvg,
  type MapMark,
  type MapMarkResult,
  type MapPin,
} from "@plugins/map/core";
import {
  MapLabel,
  MapMarkImage,
  useMapMarkEnv,
  type MapMarkEnv,
  type MapPinMarkFn,
  type MapPinProps,
} from "@plugins/map/web";
import { hoverRevealClass } from "@plugins/primitives/plugins/hover-reveal/web";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { readGoogleResultVisual } from "../internal/google-result";
import { washInk } from "../internal/pin-paint";
import { MarkTexts } from "./mark-texts";

/** The ghost disc's box, px. */
const DISC_PX = 28;
const RING_PX = 2;
const ICON_PX = 16;
/** The disc's white, a touch see-through: a proposal, not a place of yours. */
const FILL_OPACITY = 0.92;
/** Air between the disc and its name. */
const LABEL_GAP_PX = 4;

/** The number badge a ghost may wear on its top-right (a page's place). */
const BADGE_R = 8;
const BADGE_RING = 1.5;

/** What one ghost disc is drawn from. */
export interface GhostDiscInput {
  /** The look's family, leading its mark key. */
  kind: string;
  icon: IconRef;
  /** The icon's colour (CSS; resolved through the map). */
  ink: string;
  /** The ring's colour (CSS) — the icon's own by default. */
  ring?: string;
  /** Lifted (hovered, active): the ring turns solid. */
  on: boolean;
  /** A number on a badge at the disc's top-right, in `ring`'s colour. */
  badge?: { n: number; text: string };
}

/**
 * A ghost disc: a proposal on the map, not one of your places. At rest
 * (`on: false`) its ring is dashed; lifted, solid. A numbered ghost (a page's
 * place) wears its number on a badge — text the map draws, so every ghost of
 * a look shares one sprite.
 */
export function ghostDiscMark(
  {
    kind,
    icon: iconRef,
    ink: inkCss,
    ring: ringCss,
    on,
    badge,
  }: GhostDiscInput,
  env: MapMarkEnv,
): MapMarkResult {
  const icon = env.icon(iconRef, { active: true });
  if (icon.kind === "pending") return MARK_PENDING;
  const ink = env.color(inkCss);
  const ring = ringCss === undefined ? ink : env.color(ringCss);
  const badgeText = badge === undefined ? null : env.color(badge.text);
  const key = [
    kind,
    on ? "on" : "rest",
    ink,
    ring,
    badgeText ?? "",
    hash53(icon.viewBox + icon.body).toString(36),
  ].join("|");
  const id = markIdPrefix(key);
  const extra = badge === undefined ? 0 : BADGE_R;
  const { x: px, bottom } = MARK_SHADOW_PAD;
  const top = MARK_SHADOW_PAD.top + extra;
  const c = DISC_PX / 2;
  const r = c - RING_PX / 2;
  const i = (DISC_PX - ICON_PX) / 2;
  const inkAttr = escapeSvg(ink);
  const ringAttr = escapeSvg(ring);
  // The badge's centre, in the box: on the disc's top-right, overhanging it.
  const at = { x: px + DISC_PX - 2, y: top + 2 };
  const body =
    `<defs>${markShadow(`${id}s`)}</defs>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="#fff" fill-opacity="${FILL_OPACITY}" stroke="${ringAttr}" stroke-width="${RING_PX}"${on ? "" : ` stroke-dasharray="4 3"`} filter="url(#${id}s)"/>` +
    `<svg x="${i}" y="${i}" width="${ICON_PX}" height="${ICON_PX}" viewBox="${escapeSvg(icon.viewBox)}" style="color:${inkAttr};fill:${inkAttr}" overflow="visible">${icon.body}</svg>`;
  const badgeSvg =
    badge === undefined
      ? ""
      : `<circle cx="${at.x}" cy="${at.y}" r="${BADGE_R}" fill="${ringAttr}" stroke="#fff" stroke-width="${BADGE_RING}"/>`;
  const width = DISC_PX + 2 * px + extra;
  const height = DISC_PX + top + bottom;
  return {
    kind: "mark",
    key,
    svg: markSvg(
      width,
      height,
      `<g transform="translate(${px} ${top})">${body}</g>${badgeSvg}`,
    ),
    width,
    height,
    anchor: { x: px + c, y: top + c },
    labelAt: { x: px + DISC_PX + extra + LABEL_GAP_PX, centerY: top + c },
    ...(badge === undefined || badgeText === null
      ? {}
      : {
          texts: [
            {
              at: "center" as const,
              text: String(badge.n),
              color: badgeText,
              point: at,
            },
          ],
        }),
  };
}

/** A Google result's ghost disc, in the would-be tag's darkened colour. */
function ghostMark(pin: MapPin, env: MapMarkEnv, on: boolean): MapMarkResult {
  const visual = readGoogleResultVisual(pin);
  return ghostDiscMark(
    {
      kind: "google-result",
      icon: visual.icon,
      ink: washInk(visual.mainColor),
      on,
    },
    env,
  );
}

/** `GeoMap.Pin`'s mark for a Google result: the dashed ghost disc. */
export const googleResultMark: MapPinMarkFn = ({ pin }, env) =>
  ghostMark(pin, env, false);

/**
 * A Google result lifted into the DOM — which happens only while it is
 * hovered, on the map or through its card: the disc grows from its centre,
 * its ring turns solid and its name fades in beside it.
 */
export function GoogleResultPin({ pin, active, hovered, tiles }: MapPinProps) {
  const env = useMapMarkEnv(tiles);
  if (env === null) return null;
  const on = active || hovered;
  const mark = ghostMark(pin, env, on);
  if (mark.kind === "pending") return null;
  return (
    <GhostPin
      mark={mark}
      on={on}
      name={pin.label ?? "Google result"}
      tiles={tiles}
    />
  );
}

/**
 * A ghost disc lifted into the DOM: its mark (and its number, which the map
 * draws on its canvas and the DOM draws here), grown from its centre while
 * `on`, its name faded in beside it.
 */
export function GhostPin({
  mark,
  on,
  name,
  tiles,
}: {
  mark: MapMark;
  on: boolean;
  name: string;
  tiles: MapPinProps["tiles"];
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className="relative block cursor-pointer"
      style={{ width: mark.width, height: mark.height }}
    >
      <span
        className={cn("block transition-transform", on && "scale-[1.3]")}
        style={{ transformOrigin: `${mark.anchor.x}px ${mark.anchor.y}px` }}
      >
        <MapMarkImage mark={mark} />
        <MarkTexts mark={mark} />
      </span>
      <Placed
        x={{ start: mark.labelAt.x + 4 }}
        y={{ center: mark.labelAt.centerY }}
        className={cn("max-w-48 whitespace-nowrap", hoverRevealClass(on))}
      >
        <MapLabel tiles={tiles}>{name}</MapLabel>
      </Placed>
    </span>
  );
}
