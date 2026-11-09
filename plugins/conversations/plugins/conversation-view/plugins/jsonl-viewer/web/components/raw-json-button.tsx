import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dataObjectIcon = symbol("data-object");

/**
 * The event as the viewer received it, in a popover anchored to the button —
 * non-modal, so the transcript stays usable while it is open. Behind the row's
 * `⋯` the button sits in the adaptive bar's overflow panel, which stays open
 * under its occupant's popover (the popup is the innermost layer).
 */
export function RawJsonAction({ event }: { event: JsonlEvent }) {
  return (
    <InlinePopover
      trigger={<IconButton icon={dataObjectIcon} label="View raw JSON" />}
      align="end"
      width="4xl"
      padding="none"
    >
      <Scroll axis="y" className="max-h-[60vh] rounded-md">
        <JsonCode value={event} />
      </Scroll>
    </InlinePopover>
  );
}
