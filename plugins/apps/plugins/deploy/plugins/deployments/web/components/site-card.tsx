import type { ReactNode } from "react";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";

/**
 * The site page's one card chrome — an Overview card, a tab's panel: a header
 * row (title, an optional muted `meta` after it, `trailing` controls at `sm`
 * density) over a hairline, then the body. The body is the caller's: a list
 * runs edge to edge, so the card pads nothing below the header itself — wrap a
 * body that needs it in `SiteCardBody`.
 *
 * One component rather than each contributor composing `Card` + a header, so the
 * Overview's cards (contributed by five plugins) cannot drift apart.
 */
export function SiteCard({
  title,
  meta,
  trailing,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** The header's trailing controls (a link to the card's tab). */
  trailing?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <Surface level="raised">
      <Inset x="md" y="sm" className="min-h-11 border-b border-border/60">
        <Line className="min-h-7 gap-sm">
          <Text as="h3" variant="label" tone="strong">
            {title}
          </Text>
          {meta != null && (
            <Text as="span" variant="caption" tone="faint">
              {meta}
            </Text>
          )}
          <Fill />
          {trailing != null && (
            <ControlSizeProvider size="sm">{trailing}</ControlSizeProvider>
          )}
        </Line>
      </Inset>
      {children}
    </Surface>
  );
}

/**
 * A padded card body: opens the card's `md` rail region (pads AND publishes
 * it), so a DataView dropped in is inset once, by the card.
 */
export function SiteCardBody({ children }: { children: ReactNode }): ReactNode {
  return (
    <Stack gap="md" className="rail-md">
      {children}
    </Stack>
  );
}

function BodyOnlyFrame({ body }: HostedToolbarParts): ReactNode {
  return body;
}

/**
 * The toolbar of a short record list inside a `SiteCard` (an Overview card's
 * newest-three): no band, just the rows — the card already draws the title, and
 * a search over three rows would be empty chrome.
 */
export const SITE_CARD_LIST_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: BodyOnlyFrame,
};
