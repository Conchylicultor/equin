import type { ReactNode } from "react";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { BEFORE_AFTER_ICON } from "../internal/icon";

/**
 * A pair's `ba-…` id as a chip — what the agent cites, written as it does.
 * Beside the pair's own title (a tool call's card) it is the id and opens the
 * pane; inside the pane it copies the id ({@link CopyPairIdChip}).
 */
export function PairIdChip({
  id,
  activation,
  tooltip,
}: {
  id: string;
  activation: Activation;
  tooltip: string;
}): ReactNode {
  return (
    <LinkChip
      mono
      leading={<Icon icon={BEFORE_AFTER_ICON} />}
      activation={activation}
      tooltip={tooltip}
    >
      {id}
    </LinkChip>
  );
}

/** The id chip of the pair a viewer shows: a click copies the id, to cite it. */
export function CopyPairIdChip({ id }: { id: string }): ReactNode {
  const { copy, copied } = useCopyToClipboard(id);
  return (
    <PairIdChip
      id={id}
      activation={copy}
      tooltip={copied ? "Copied" : "Copy the id"}
    />
  );
}
