import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import type { MailMessage } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { addressLabel, recipientsLabel } from "../internal/format-address";
import { MessageBody } from "./message-body";
import { symbol } from "@plugins/ui/plugins/icons/core";

const keyboardArrowUpIcon = symbol("keyboard-arrow-up");

export interface MessageCardProps {
  message: MailMessage;
  /** The newest message opens by default; older ones collapse to a summary. */
  defaultOpen: boolean;
}

// One message in a thread: a raised card that collapses to a one-line summary
// (sender · snippet · date) and expands to the full header + body. The two
// faces swap on one fold — the summary folds away as the full message unfolds —
// and the body is only mounted (and hydrated) while expanded.
export function MessageCard({ message, defaultOpen }: MessageCardProps) {
  const { open, toggle, contentProps, triggerControlProps } = useCollapsible({
    defaultOpen,
  });

  const fromLabel = addressLabel(message.from);
  const date = message.internalDate;
  const absolute = date ? date.toLocaleString() : undefined;

  return (
    <Surface level="raised" className="rounded-lg">
      <Inset pad="md">
        <FoldMotion {...contentProps}>
          <Stack gap="sm">
            <Inline gap="sm" align="start">
              <Avatar
                fallbackGlyph={fromLabel}
                fallbackKey={message.from.email}
              />
              <Fill>
                <Stack gap="none">
                  <Text variant="label">{fromLabel}</Text>
                  {message.from.name ? (
                    <Text variant="caption" tone="muted">
                      {message.from.email}
                    </Text>
                  ) : null}
                  {message.to.length > 0 ? (
                    <Text variant="caption" tone="muted">
                      to {recipientsLabel(message.to)}
                    </Text>
                  ) : null}
                </Stack>
              </Fill>
              <Inline gap="2xs" align="center">
                {date ? (
                  <Text variant="caption" tone="muted" title={absolute}>
                    <RelativeTime date={date} />
                  </Text>
                ) : null}
                <IconButton
                  icon={keyboardArrowUpIcon}
                  label="Collapse"
                  onClick={toggle}
                />
              </Inline>
            </Inline>
            <MessageBody messageId={message.id} />
          </Stack>
        </FoldMotion>
        <FoldMotion open={!open}>
          <Row
            icon={
              <ControlSizeProvider size="sm">
                <Avatar
                  fallbackGlyph={fromLabel}
                  fallbackKey={message.from.email}
                />
              </ControlSizeProvider>
            }
            actionsAlwaysVisible
            actions={
              date ? (
                <Text variant="caption" tone="muted" title={absolute}>
                  <RelativeTime date={date} />
                </Text>
              ) : null
            }
            title={message.snippet ?? fromLabel}
            {...triggerControlProps}
          >
            <Text variant="label">{fromLabel}</Text>
            <Text tone="muted">{message.snippet ?? ""}</Text>
          </Row>
        </FoldMotion>
      </Inset>
    </Surface>
  );
}
