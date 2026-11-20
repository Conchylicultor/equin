import type { ReactNode } from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * A block of a site's row body (`SiteLive.Section`): its name as a small-caps
 * label, what it says in one figure at the line's end (`aside`: "312 today",
 * "Up 6 d" — pieces of {@link SiteLiveAside}, laid out in a row so a slot's
 * contributions can join them), and its content under them. Every section draws through it, so
 * the blocks of one row cannot drift apart.
 */
export function SiteLiveBlock({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Line className="gap-sm">
        <Text variant="eyebrow" tone="faint">
          {title}
        </Text>
        <Fill />
        {aside !== undefined ? <Inline gap="none">{aside}</Inline> : null}
      </Line>
      {children}
    </Stack>
  );
}

/** One piece of a block's `aside`: caption-sized, muted, tabular figures. */
export function SiteLiveAside({ children }: { children: ReactNode }) {
  return (
    <Text
      variant="caption"
      tone="muted"
      className="tabular-nums whitespace-pre"
    >
      {children}
    </Text>
  );
}
