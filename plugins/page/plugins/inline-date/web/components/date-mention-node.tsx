import { useState } from "react";
import { $getNodeByKey, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { DatePickerPanel } from "@plugins/primitives/plugins/date-picker/web";
import { dateMentionNode, type DateMentionFields } from "../../core";
import { DateMentionChip } from "./date-mention-chip";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteIcon = symbol("delete");
const notificationsActiveIcon = symbol("notifications-active");

/**
 * The browser half of the inline date-mention token: the SAME family declared in
 * `core/node.ts`, with rendering added.
 *
 * Clicking the chip opens a date picker; edits rewrite the node's fields. There
 * is no server call on either edit — reminders are reconciled from the block's
 * text on every `page.blocksChanged`, so rewriting the token IS the whole
 * operation.
 */
export const dateMentionWebNode = dateMentionNode.decorated({
  className: "inline-flex align-baseline",
  render: (fields, node) => (
    <DateMentionView fields={fields} nodeKey={node.getKey()} />
  ),
});

/** The Lexical class to register in a block editor's `nodes` config. */
export const DateMentionNode = dateMentionWebNode.Node;

function DateMentionView({
  fields,
  nodeKey,
}: {
  fields: DateMentionFields;
  nodeKey: string;
}) {
  const { iso, reminderId } = fields;
  const [lexicalEditor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const date = new Date(iso);
  const isReminder = reminderId !== null;

  function mutate(apply: (node: LexicalNode) => void) {
    lexicalEditor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node && dateMentionNode.is(node)) apply(node);
    });
  }

  const chip = (
    <DateMentionChip
      iso={iso}
      reminderId={reminderId}
      // The popover owns the press: it must BUBBLE to the trigger below, whose
      // base-ui handler is the only thing that knows about the outside-press
      // that just closed the panel (a stopPropagation + setOpen here would
      // reopen the panel on the click that dismissed it). No activation, so
      // the chip adds no handler of its own.
      activation={undefined}
    />
  );

  // Read-only render (history preview, non-editable editor): the bare chip.
  if (!lexicalEditor.isEditable()) return chip;

  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      width="content"
      padding="sm"
      trigger={
        // A real element for the popover to anchor to (LinkChip forwards no ref).
        // The editor must not see the click as a click on the block's text.
        <Inline
          gap="none"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {chip}
        </Inline>
      }
    >
      <Stack gap="sm">
        <DatePickerPanel
          value={date}
          onChange={(next: Date) =>
            mutate((node) =>
              dateMentionNode.setFields(node, { iso: next.toISOString() }),
            )
          }
          // A reminder fires at an instant, so it needs a time-of-day; a plain
          // date mention does not.
          withTime={isReminder}
        />
        <Line>
          <ToggleChip
            active={isReminder}
            variant="ghost"
            icon={<Icon icon={notificationsActiveIcon} />}
            // Minting/clearing the id is the ENTIRE reminder operation — the
            // server reconciles reminders from the block text on the next
            // `page.blocksChanged`.
            onClick={() =>
              mutate((node) =>
                dateMentionNode.setFields(node, {
                  reminderId: isReminder ? null : crypto.randomUUID(),
                }),
              )
            }
          >
            Remind me
          </ToggleChip>
          <Fill />
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              mutate((node) => node.remove());
            }}
          >
            <Icon icon={deleteIcon} />
            Remove
          </Button>
        </Line>
      </Stack>
    </InlinePopover>
  );
}

export function $createDateMentionNode(
  iso: string,
  reminderId: string | null = null,
): LexicalNode {
  return dateMentionWebNode.create({ iso, reminderId });
}
