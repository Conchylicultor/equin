import type { ReactElement } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Meter } from "@plugins/primitives/plugins/css/plugins/meter/web";

// Determinate progress for the cluster fan-out: a label ("scanning X / N") plus
// a token-only track whose fill width tracks received/total. Before the first
// `{ total }` frame arrives `total` is null, so we show an empty track and a
// generic "scanning…" label rather than a fake percentage.
export function ScanProgress({
  received,
  total,
}: {
  received: number;
  total: number | null;
}): ReactElement {
  const fraction = total ? received / total : 0;
  return (
    <Stack gap="2xs">
      <Text as="span" variant="caption" className="text-muted-foreground">
        {total == null
          ? "Scanning worktrees…"
          : `Scanning worktrees… ${received} / ${total}`}
      </Text>
      <Meter value={fraction} label="Scanning worktrees" role="progressbar" />
    </Stack>
  );
}
