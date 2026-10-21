import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
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
      <Scroll axis="both" className="max-h-[60vh] rounded-md bg-muted/40 p-md">
        <Text as="pre" variant="caption">
          {JSON.stringify(event, null, 2)}
        </Text>
      </Scroll>
    </InlinePopover>
  );
}
