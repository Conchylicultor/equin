import type { ReactElement } from "react";
import {
  isolatedExhibit,
  type Exhibit,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  SwipeCompare,
  type SwipeCompareMode,
} from "@plugins/primitives/plugins/diff-view/plugins/swipe-compare/web";

/** A placeholder side: a flat field in one theme colour with its name on it. */
function Placeholder({
  tone,
  children,
}: {
  tone: "before" | "after";
  children: string;
}): ReactElement {
  return (
    <Center
      className={
        tone === "before"
          ? "size-full bg-muted text-muted-foreground"
          : "size-full bg-primary text-primary-foreground"
      }
    >
      <Text variant="display">{children}</Text>
    </Center>
  );
}

/** The two placeholders compared in `mode`, at 16:10 in a 320px-tall stage. */
function Pair({ mode }: { mode: SwipeCompareMode }): ReactElement {
  return (
    <div className="h-80">
      <SwipeCompare
        mode={mode}
        aspect={16 / 10}
        before={<Placeholder tone="before">Before</Placeholder>}
        after={<Placeholder tone="after">After</Placeholder>}
      />
    </div>
  );
}

export const swipeCompareExhibits: Exhibit[] = [
  isolatedExhibit({
    id: "swipe-compare/images",
    label: "Swipe compare — swipe",
    widths: [360, 640, 960],
    render: () => <Pair mode="swipe" />,
  }),
  isolatedExhibit({
    id: "swipe-compare/side",
    label: "Swipe compare — side by side",
    widths: [360, 640, 960],
    render: () => <Pair mode="side" />,
  }),
  isolatedExhibit({
    id: "swipe-compare/flip",
    label: "Swipe compare — flip",
    widths: [360, 640, 960],
    render: () => <Pair mode="flip" />,
  }),
];
