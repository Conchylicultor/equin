import {
  Button,
  cn,
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { extensionLength, splitForMiddleTruncate } from "../../core";
import type { ImageFailure } from "../internal/use-image-load";

const goneIcon = symbol("hide-image");
const unreadableIcon = symbol("broken-image");

export interface MissingImageProps {
  /** The file name, shown middle-truncated (its end always shows). */
  name: string;
  /** What the tooltip shows. Defaults to `name`. */
  title?: string;
  reason: ImageFailure;
  /** Offered while `reason` is `unreadable`: a gone file stays gone. */
  onRetry?: () => void;
  /** `inline` — a transcript image's box; `chip` — the 64px attachment chip,
   *  without the reason line. Matches `ViewerThumbnail`'s sizes. `fill` — the
   *  whole of its parent's box, for an image that is cropped to one (a page
   *  cover). */
  size?: "inline" | "chip" | "fill";
}

/** A fixed box per size, so a set of missing images keeps the grid an image
 *  set would — never sized by the text inside it. */
const BOX: Record<NonNullable<MissingImageProps["size"]>, string> = {
  inline: "h-32 w-56 p-sm",
  chip: "h-16 w-24 p-xs",
  fill: "size-full p-sm",
};

/**
 * What an image that did not load shows instead of the browser's broken-image
 * glyph: a dashed box with the file's name and why it is not there. Not a
 * button — there is nothing to open.
 */
export function MissingImage({
  name,
  title,
  reason,
  onRetry,
  size = "inline",
}: MissingImageProps) {
  const chip = size === "chip";
  // A chip has room for a few letters: spend them on the name's start, and keep
  // only the extension whole.
  const { head, tail } = splitForMiddleTruncate(
    name,
    chip ? extensionLength(name) : undefined,
  );
  const unreadable = reason === "unreadable";
  return (
    <WithTooltip content={title ?? name}>
      <Stack
        as="span"
        role="img"
        aria-label={`Image unavailable: ${name}`}
        gap={chip ? "2xs" : "xs"}
        align="center"
        justify="center"
        className={cn(
          "max-w-full rounded-md border border-dashed border-border bg-muted text-center align-top text-muted-foreground",
          BOX[size],
        )}
      >
        <Icon
          icon={unreadable ? unreadableIcon : goneIcon}
          className={cn(
            chip ? "size-4" : "size-5",
            unreadable && "text-warning",
          )}
        />
        {/* Middle truncation: the head gives up its letters, the tail never. */}
        <Line
          as="span"
          className={cn(
            "max-w-full font-mono text-foreground/80",
            chip && "text-2xs",
          )}
        >
          <Text variant={chip ? undefined : "code"}>{head}</Text>
          <Rigid as="span">
            <Text variant={chip ? undefined : "code"}>{tail}</Text>
          </Rigid>
        </Line>
        {!chip && reason !== "probing" && (
          <Text variant="caption" tone="muted">
            {unreadable ? (
              <>
                Couldn&apos;t load
                {onRetry && (
                  <>
                    {" · "}
                    <ControlSizeProvider size="xs">
                      <Button variant="link" onClick={onRetry}>
                        Retry
                      </Button>
                    </ControlSizeProvider>
                  </>
                )}
              </>
            ) : (
              "No longer available"
            )}
          </Text>
        )}
      </Stack>
    </WithTooltip>
  );
}
