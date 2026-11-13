import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * One labelled block of a companion's panel: a caption-sized title ("Apps",
 * "Wish", "equin.ai") on the rows' rail, then its body. Every section with a
 * title draws it through this, so titles look the same in every section and
 * every companion (the prototypes' `.sect`: small, semibold, muted).
 */
export function PanelSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="none">
      <Text
        as="div"
        variant="caption"
        tone="muted"
        className={cn(
          "font-semibold",
          insetClass({ x: "lg", t: "md", b: "2xs" }),
        )}
      >
        {label}
      </Text>
      {children}
    </Stack>
  );
}
