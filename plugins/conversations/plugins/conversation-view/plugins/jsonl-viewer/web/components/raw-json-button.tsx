import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { DialogTitle } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dataObjectIcon = symbol("data-object");

/**
 * The event as the viewer received it, in a dialog. A dialog rather than a
 * popover anchored to the button: the row's config folds this action behind the
 * ⋯, where the button is a panel row that closes as the action runs.
 */
export function RawJsonAction({ event }: { event: JsonlEvent }) {
  return (
    <IconButton
      icon={dataObjectIcon}
      label="View raw JSON"
      onClick={() =>
        void openDialog(
          () => (
            <Stack gap="sm">
              <DialogTitle>Raw JSON</DialogTitle>
              <Scroll
                axis="both"
                className="max-h-[60vh] rounded-md bg-muted/40 p-md"
              >
                <Text as="pre" variant="caption">
                  {JSON.stringify(event, null, 2)}
                </Text>
              </Scroll>
            </Stack>
          ),
          { size: "lg" },
        )
      }
    />
  );
}
