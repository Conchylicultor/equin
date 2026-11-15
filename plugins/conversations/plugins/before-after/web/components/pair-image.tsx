import type { ReactNode } from "react";
import { getAttachmentFile } from "@plugins/infra/plugins/attachments/core";
import { assetPath } from "@plugins/infra/plugins/endpoints/core";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { BeforeAfterPair } from "../../core";

const brokenImageIcon = symbol("broken-image");

/**
 * How a side fills its box: `contain` — whole, never cropped (a comparison,
 * whose box is the pair's own aspect anyway); `cover` — filling it from the
 * top-left (a thumbnail tile, which crops a tall capture to its top).
 */
export type PairImageFit = "contain" | "cover";

/**
 * One side of a pair: its PNG attachment (`GET /api/attachments/:id`, loaded
 * over the subtree's transport) filling its box as `fit` says. While it loads
 * the box's own tint shows; a failure says so, with the reason on hover.
 */
export function PairImage({
  attachmentId,
  alt,
  fit = "contain",
}: {
  attachmentId: string;
  alt: string;
  fit?: PairImageFit;
}): ReactNode {
  const src = useAssetSrc(assetPath(getAttachmentFile, { id: attachmentId }));
  if (src.kind === "loading") return null;
  if (src.kind === "ready")
    return (
      <img
        src={src.src}
        alt={alt}
        decoding="async"
        draggable={false}
        className={cn(
          "block size-full",
          fit === "cover" ? "object-cover object-left-top" : "object-contain",
        )}
      />
    );
  return (
    <Center
      title={src.message}
      aria-label={`${alt} failed to load — ${src.message}`}
      className="size-full text-destructive"
    >
      <Icon icon={brokenImageIcon} className="size-5" />
    </Center>
  );
}

/** The pair's before side, named for a screen reader. */
export function BeforeImage({
  pair,
  fit,
}: {
  pair: BeforeAfterPair;
  fit?: PairImageFit;
}): ReactNode {
  return (
    <PairImage
      fit={fit}
      attachmentId={pair.beforeAttachmentId}
      alt={`${pair.title} — ${pair.beforeLabel}`}
    />
  );
}

/** The pair's after side, named for a screen reader. */
export function AfterImage({
  pair,
  fit,
}: {
  pair: BeforeAfterPair;
  fit?: PairImageFit;
}): ReactNode {
  return (
    <PairImage
      fit={fit}
      attachmentId={pair.afterAttachmentId}
      alt={`${pair.title} — ${pair.afterLabel}`}
    />
  );
}

/**
 * A pair's thumbnail: before on the left half, after on the right, a hairline
 * between them — the whole comparison at a glance. Fills the box it is given
 * (a gallery cover, an Artifacts tile); the box owns corners, tint and ring.
 * The hairline is fixed white, like the swipe divider: it sits over an
 * arbitrary picture, which no palette knows.
 */
export function SplitThumb({ pair }: { pair: BeforeAfterPair }): ReactNode {
  return (
    <>
      <Layer>
        <BeforeImage pair={pair} fit="cover" />
      </Layer>
      <Layer style={{ clipPath: "inset(0 0 0 50%)" }}>
        <AfterImage pair={pair} fit="cover" />
      </Layer>
      <Placed
        x={{ start: pct(0.5), size: 1 }}
        y="fill"
        layer="raised"
        decorative
        className="bg-white/80"
      />
    </>
  );
}

/** `route · W × H` — what the pair shows, on one line (which side is which is
 *  on the comparison's own Before / After tags). */
export function pairCaption(pair: BeforeAfterPair): string {
  return [pair.route, `${String(pair.width)} × ${String(pair.height)}`]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** A muted note in place of a pair that is not (yet) there. */
export function PairNote({ children }: { children: string }): ReactNode {
  return (
    <Text variant="caption" tone="muted">
      {children}
    </Text>
  );
}
