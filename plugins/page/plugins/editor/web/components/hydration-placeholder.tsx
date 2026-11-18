import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { CollabBlockDoc } from "../internal/use-collab-block-doc";

/**
 * What a LIVE block shows while its content session has not PROVEN that the
 * text on screen is the text its doc holds (`collab-session.ts` owns the state;
 * this is the only thing that renders it).
 *
 * - **`hydrated`** — nothing. The block renders its own text.
 * - **`stalled`** — a VISIBLE retry (`rehydrate()` — end this session, start a
 *   new one). The binding demonstrably renders less than its replica holds,
 *   which is a real defect with a real remedy, so it must not sit behind an
 *   indefinite wait. It is right-aligned and covers nothing, and it never
 *   covers the start of the line the user can keep typing into either —
 *   `hydrating` gates the WRITE path, not the editing host.
 * - **still hydrating** — nothing HERE: the editor is not on screen yet. Until
 *   it is ready (`CollabBinding`'s `ready`) the block keeps its static line —
 *   the row's text, which is the block's text as last projected — in place of
 *   the editor (`BlockTextRenderer`), so there is no skeleton to paint: stale
 *   text beats a blank line, and the static line IS that text.
 */
export function HydrationPlaceholder({ doc }: { doc: CollabBlockDoc }) {
  const { hydration, rehydrate } = doc;
  if (hydration.kind !== "stalled") return null;
  return (
    <Pin to="top-right">
      <Inset y="xs">
        <ControlSizeProvider size="xs">
          <Inline gap="xs">
            <Text variant="caption" tone="muted">
              Text didn&rsquo;t load
            </Text>
            <Button variant="outline" onClick={rehydrate}>
              Retry
            </Button>
          </Inline>
        </ControlSizeProvider>
      </Inset>
    </Pin>
  );
}
