import type { ReactNode } from "react";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceError } from "../../core";

const errorIcon = symbol("error");

export interface ResourceErrorInlineProps {
  /** The failure — a result's error arm's `error` (any `Error` is accepted and read as `loader-failed`). */
  error: Error;
  /** The failed read's `refetch`. Absent → no Retry is offered (Reload still is, for an outdated tab). */
  refetch?: () => Promise<void>;
  /**
   * How much room the failure gets:
   * - `block` — a centred message with its action below: a failed pane or list body.
   * - `inline` — message and action in one line of text: a failed field or card line.
   * - `icon` — one destructive icon button whose tooltip names the failure and
   *   whose click is the action: a failed toolbar control.
   */
  variant: "block" | "inline" | "icon";
  /** What failed to load, for the message ("the build history"). */
  subject?: string;
  /** `icon` only: the control's own icon, so a failed toolbar button keeps its face. */
  icon?: IconRef;
}

/**
 * The one rendering of a failed read, with its one remedy: Retry (the read's
 * own `refetch`), or — when the tab's bundle is out of date
 * (`client-outdated`) — "App updated — reload", which reloads the page, since
 * no retry of the same bundle can succeed. A `refused` read shows the server's
 * message and no remedy: asking the same question again gets the same answer.
 *
 * The error arm of a `ResourceResult` renders through this unless a surface has
 * a better answer (keeping `stale` on screen, say); `matchResource` /
 * `ResourceView` and DataView's `readiness` use it by default.
 */
export function ResourceErrorInline({
  error,
  refetch,
  variant,
  subject,
  icon,
}: ResourceErrorInlineProps): ReactNode {
  const outdated =
    error instanceof ResourceError && error.kind === "client-outdated";
  const message = outdated
    ? "App updated — reload to load this."
    : `Couldn't load${subject === undefined ? "" : ` ${subject}`}: ${error.message}`;
  // A refused question gets the same answer however often it is asked: no Retry.
  const refused = error instanceof ResourceError && error.kind === "refused";
  const action: { label: string; run: () => Promise<void> | void } | null =
    outdated
      ? { label: "Reload", run: () => window.location.reload() }
      : refetch === undefined || refused
        ? null
        : { label: "Retry", run: refetch };

  if (variant === "icon") {
    const verb =
      action === null ? "" : ` Click to ${action.label.toLowerCase()}.`;
    return (
      <IconButton
        icon={icon ?? errorIcon}
        label={`${message}${verb}`}
        className="text-destructive hover:text-destructive"
        disabled={action === null}
        onClick={action === null ? undefined : () => action.run()}
      />
    );
  }

  if (variant === "inline") {
    return (
      <Inline gap="xs">
        <span className="text-destructive">{message}</span>
        {action !== null && (
          <ControlSizeProvider size="xs">
            <Button variant="link" onClick={() => action.run()}>
              {action.label}
            </Button>
          </ControlSizeProvider>
        )}
      </Inline>
    );
  }

  return (
    <Center axis="horizontal">
      <Inset pad="sm">
        <Stack gap="xs" align="center">
          <Placeholder tone="error">{message}</Placeholder>
          {action !== null && (
            <ControlSizeProvider size="sm">
              <Button variant="ghost" onClick={() => action.run()}>
                {action.label}
              </Button>
            </ControlSizeProvider>
          )}
        </Stack>
      </Inset>
    </Center>
  );
}
