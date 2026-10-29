import type { ComponentProps, ReactElement } from "react";
import { useAudience } from "@plugins/audience/web";
import { DeveloperMark } from "@plugins/audience/plugins/developer-mark/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  tabOriginLabel,
  useTabOrigin,
  type TabOrigin,
  type TabStamp,
} from "@plugins/apps-core/plugins/tab-origin/web";
import { useIdKinds } from "@plugins/ids/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  afterOpen,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Notification } from "../../shared/resources";
import type { NotificationAction, NotificationCategory } from "../../core";
import {
  Notifications,
  resolveActionKind,
  type NotificationActionKind,
} from "../internal/actions";

/**
 * What a notification's view reads — a stored row (the bell) or the arguments
 * of a toast this page raised itself (`useToast`) carry the same fields, so
 * both surfaces draw one component.
 */
export type NotificationContent = Pick<
  Notification,
  | "type"
  | "title"
  | "description"
  | "variant"
  | "category"
  | "audience"
  | "subjectId"
  | "subjectName"
  | "detail"
  | "action"
  | "icon"
  | "linkTo"
  | "metadata"
  | "count"
>;

const CATEGORY_ICON: Record<NotificationCategory, IconRef> = {
  conversations: symbol("forum"),
  updates: symbol("update"),
  automations: symbol("schedule"),
  reports: symbol("bug-report"),
  other: symbol("notifications"),
};
const errorIcon = symbol("error");
const warningIcon = symbol("warning");

/**
 * The glyph: the event's own (`icon`, set by its producer), else a failure's
 * (error / warning), else the category's. An error or warning is tinted red /
 * amber whichever glyph it draws; everything else is faint.
 */
function glyph(n: NotificationContent): { icon: IconRef; className: string } {
  if (n.variant === "error") {
    return { icon: n.icon ?? errorIcon, className: "text-destructive" };
  }
  if (n.variant === "warning") {
    return { icon: n.icon ?? warningIcon, className: "text-warning" };
  }
  return {
    icon: n.icon ?? CATEGORY_ICON[n.category],
    className: "text-faint-foreground",
  };
}

/** The recurrence count as the meta line shows it (`×12`, `×99+`). */
export function recurrenceLabel(count: number): string | null {
  if (count <= 1) return null;
  return `×${count > 99 ? "99+" : count}`;
}

/**
 * Which tab raised it, for a notification a browser tab wrote (its
 * `metadata.clientId` and `metadata.clientUrl`): "this tab", or the other tab
 * by its app and whether it is still open ("another Places tab", "closed
 * Places tab"); null for one the server raised. Said of a failure only — where
 * it happened is part of what went wrong; a confirmation needs no origin. A
 * toast names only another tab: one this tab raised pops up under the action
 * that caused it, so its origin is plain; the bell's list, read later, names
 * both.
 */
export function raisedByTab(
  n: Pick<NotificationContent, "variant">,
  origin: TabOrigin,
  surface: NotificationSurface,
): string | null {
  if (n.variant !== "error" && n.variant !== "warning") return null;
  if (origin.kind === "this" && surface === "toast") return null;
  return tabOriginLabel(origin);
}

/** The stamp a notification carries: who raised it, on which page. */
function tabStampOf(
  n: Pick<NotificationContent, "metadata" | "variant">,
): TabStamp {
  // Only a failure names its tab — skip the presence read for the rest.
  const failure = n.variant === "error" || n.variant === "warning";
  const clientId = n.metadata?.clientId;
  const clientUrl = n.metadata?.clientUrl;
  return {
    clientId: failure && typeof clientId === "string" ? clientId : null,
    url: typeof clientUrl === "string" ? clientUrl : null,
  };
}

/** {@link raisedByTab} for a drawn notification: reads its tab's origin. */
export function useRaisedByTab(
  n: Pick<NotificationContent, "metadata" | "variant">,
  surface: NotificationSurface,
): string | null {
  return raisedByTab(n, useTabOrigin(tabStampOf(n)), surface);
}

/**
 * The notification's one action: its own, else — a row written before actions
 * existed — an implicit `open` of its in-app `linkTo`.
 */
export function notificationAction(
  n: Pick<NotificationContent, "action" | "linkTo">,
): NotificationAction | null {
  if (n.action !== null) return n.action;
  if (n.linkTo?.startsWith("/")) {
    return { kind: "open", payload: { to: n.linkTo } };
  }
  return null;
}

type LinkKind = Extract<NotificationActionKind, { useLink: unknown }>;
type RunKind = Extract<NotificationActionKind, { useRun: unknown }>;
type ControlKind = Extract<NotificationActionKind, { Control: unknown }>;
type Payload = NotificationAction["payload"];

/**
 * Where the notification is drawn, which decides what clicking it does:
 * - `bell` — the popover's row is a link to its action's target (a `useLink`
 *   kind): clicking the row opens it.
 * - `toast` — the body never navigates: clicking anywhere but its controls
 *   only dismisses it (the toast host's click-to-dismiss); its action button
 *   is the only way to act on it.
 */
export type NotificationSurface = "bell" | "toast";

/** What every surface passes through to the drawn notification. */
interface ViewProps {
  n: NotificationContent;
  surface: NotificationSurface;
  /** The bell's relative time (absent in a toast). */
  when?: Date;
  /** The bell's unread dot — the only mark of unread (same weight for all). */
  unread?: boolean;
  /**
   * After the notification was acted on — its action ran, or it was opened
   * (the bell closes its popover).
   */
  onActed?: () => void;
  /**
   * The toast's own dismiss: a notification with no action offers a quiet ×
   * in the action's place instead.
   */
  onDismiss?: () => void;
  /** The surface's frame around the view (padding, hover fill, radius). */
  className?: string;
}

/** The one action button, at the compact control size. */
function ActionButton({
  label,
  ...handlers
}: { label: string } & Pick<
  ComponentProps<typeof Button>,
  "onClick" | "onAuxClick" | "onMouseDown"
>): ReactElement {
  return (
    <ControlSizeProvider size="xs">
      <Button variant="secondary" {...handlers}>
        {label}
      </Button>
    </ControlSizeProvider>
  );
}

/**
 * A notification whose action GOES somewhere: the button is that link, and in
 * the bell the whole row opens it too (a toast's body never does — see
 * `NotificationSurface`). Its
 * own component, keyed by kind where it is rendered, so the kind's hook is
 * called unconditionally and a different kind remounts.
 */
function LinkedView({
  kind,
  payload,
  ...view
}: ViewProps & { kind: LinkKind; payload: Payload }): ReactElement {
  const link = kind.useLink();
  const { onActed } = view;
  const target = afterOpen(link(payload), () => {
    onActed?.();
  });
  return (
    <NotificationLayout
      {...view}
      activation={view.surface === "bell" ? target : undefined}
      button={
        <ActionButton
          label={kind.label}
          // The row opens the same target: the button's click must not
          // reach it too.
          {...activationProps(target, { isolate: true })}
        />
      }
    />
  );
}

/** A notification whose action DOES something: only its button runs it. */
function RunView({
  kind,
  payload,
  ...view
}: ViewProps & { kind: RunKind; payload: Payload }): ReactElement {
  const run = kind.useRun();
  const { onActed } = view;
  return (
    <NotificationLayout
      {...view}
      activation={undefined}
      button={
        <ActionButton
          label={kind.label}
          onClick={() => {
            run(payload);
            onActed?.();
          }}
        />
      }
    />
  );
}

/**
 * A notification whose action draws its own control (a launch popover): the
 * kind renders it, at the compact size, from the payload.
 */
function ControlView({
  kind,
  payload,
  ...view
}: ViewProps & { kind: ControlKind; payload: Payload }): ReactElement {
  const { Control } = kind;
  return (
    <NotificationLayout
      {...view}
      activation={undefined}
      button={
        <ControlSizeProvider size="xs">
          <Control payload={payload} label={kind.label} />
        </ControlSizeProvider>
      }
    />
  );
}

/**
 * One notification, drawn the same in the toast and in the bell's row: icon ·
 * one-line headline (same weight for every row) · line 2 (the subject's name,
 * else the description) · the one action. In the bell, `when` puts the time at
 * the top right with the action under it. A developer reader also sees the
 * `detail` line (internals), marked developer-only.
 *
 * In the bell, a notification whose action is a link (`open`, or a legacy
 * in-app `linkTo`) opens it from anywhere on the row, keyboard included; a
 * toast opens it only from its button (`NotificationSurface`).
 *
 * An action whose kind no plugin registered throws: a notification that names
 * an action must be able to offer it.
 */
export function NotificationView(props: ViewProps): ReactElement {
  const kinds = Notifications.Action.useContributions();
  const action = notificationAction(props.n);
  if (action === null) {
    return (
      <NotificationLayout {...props} activation={undefined} button={null} />
    );
  }
  const kind = resolveActionKind(kinds, action.kind);
  if (kind.useLink !== undefined) {
    return (
      <LinkedView
        key={kind.kind}
        {...props}
        kind={kind}
        payload={action.payload}
      />
    );
  }
  if (kind.useRun !== undefined) {
    return (
      <RunView
        key={kind.kind}
        {...props}
        kind={kind}
        payload={action.payload}
      />
    );
  }
  return (
    <ControlView
      key={kind.kind}
      {...props}
      kind={kind}
      payload={action.payload}
    />
  );
}

const closeIcon = symbol("close");

/**
 * One small faint line under line 2: the recurrence count, the kind (a
 * developer row), which tab raised it — `·`-separated, absent when empty.
 */
function MetaLine({
  parts,
}: {
  parts: readonly (string | null | false)[];
}): ReactElement | null {
  const shown = parts.filter((p): p is string => typeof p === "string");
  if (shown.length === 0) return null;
  return (
    <Line className="gap-xs">
      {shown.map((p, i) => (
        <Text
          key={p}
          variant="caption"
          tone={i === 0 && p.startsWith("×") ? "muted" : "faint"}
          className="tabular-nums"
        >
          {i > 0 ? `· ${p}` : p}
        </Text>
      ))}
    </Line>
  );
}

/**
 * A cell exactly one headline line tall: `h-lh` measured in the headline's
 * own role (`body`), so whatever sits in it centres on the headline's first
 * line.
 */
const HEADLINE_LINE = "h-lh text-body";

/**
 * The drawn notification. Three tracks — leading icon · text · trailing (time
 * and action) — top-aligned, where every rigid cell beside the text (the icon,
 * the unread dot, the time, the toast's lone button) sits in a cell exactly
 * one HEADLINE line tall (`h-lh` in the headline's role), so it centres on the
 * headline's first line whatever the rest of the row holds.
 *
 * With an `activation`, the icon and text are one real `<button>` (focusable,
 * Enter / Space), and a full-bleed hit area under the content makes the whole
 * padded frame click it. The action button is its SIBLING, never its child
 * — the `Row` split pattern — so the two click targets never nest.
 */
function NotificationLayout({
  n,
  surface,
  when,
  unread = false,
  onDismiss,
  className,
  activation,
  button,
}: ViewProps & {
  activation: Activation | undefined;
  button: ReactElement | null;
}): ReactElement {
  const audience = useAudience();
  const developer =
    audience.status === "ready" && audience.data === "developer";
  const idKinds = useIdKinds();
  const { icon, className: iconTone } = glyph(n);
  // A developer row (equin's own telemetry) says what it is in its
  // description, wrapped to two lines under the headline; a user row's line 2
  // is its subject, else its description, on one line.
  const developerRow = n.audience === "developer";
  const description =
    n.description && n.description !== n.title ? n.description : null;
  const subjectKind =
    n.subjectId === null
      ? undefined
      : idKinds.find((k) => k.is(n.subjectId ?? ""));
  const raisedBy = useRaisedByTab(n, surface);
  const meta = [
    recurrenceLabel(n.count),
    developerRow && n.type ? n.type : null,
    raisedBy,
  ];

  const content = (
    <>
      {/* The glyph sits in a line box of the headline's own role, inline and
          `align-middle` — so its centre is the headline's x-height centre
          (baseline + ½ex), not the line box's, whatever the role's
          line-height. The unread dot rides the same box. */}
      <span className={cn(rigidClass(), HEADLINE_LINE, "block")}>
        <Inline gap="none" className="relative align-middle">
          {unread && (
            // In the row's leading padding, level with the glyph.
            <Pin as="span" to="left" offset="sm" outset decorative>
              {/* The compact dot: it lives in the row's leading padding. */}
              <ControlSizeProvider size="xs">
                <StatusDot colorClass="bg-info" className="block" />
              </ControlSizeProvider>
            </Pin>
          )}
          <Icon
            icon={icon}
            active={n.variant === "error" || n.variant === "warning"}
            className={cn("icon-auto", iconTone)}
          />
        </Inline>
      </span>
      <Fill>
        {/* Flow, not a flex line: the developer mark is an inline
            `align-middle` box, level with the words like the glyph. */}
        <Text
          as="p"
          variant="body"
          tone="strong"
          className="truncate font-semibold"
        >
          {n.title}
          {developerRow && (
            <>
              {" "}
              <DeveloperMark />
            </>
          )}
        </Text>
        {developerRow && description !== null && (
          <Text
            as="p"
            variant="caption"
            tone="muted"
            className="line-clamp-2 break-words"
          >
            {description}
          </Text>
        )}
        {n.subjectName !== null ? (
          <Line>
            <Badge
              colorClass="bg-muted text-foreground"
              tooltip={subjectKind?.label}
            >
              {n.subjectName}
            </Badge>
          </Line>
        ) : (
          !developerRow &&
          description !== null && (
            <Line>
              <Text variant="caption" tone="muted">
                {description}
              </Text>
            </Line>
          )
        )}
        <MetaLine parts={meta} />
        {developer && n.detail !== null && (
          <Line className="gap-xs">
            <DeveloperMark />
            <Text variant="caption" tone="faint">
              {n.detail}
            </Text>
          </Line>
        )}
      </Fill>
    </>
  );

  const dismiss =
    button === null && onDismiss !== undefined ? (
      <ControlSizeProvider size="xs">
        <IconButton icon={closeIcon} label="Dismiss" onClick={onDismiss} />
      </ControlSizeProvider>
    ) : null;

  return (
    <Stack
      direction="row"
      gap="sm"
      align="start"
      data-notification-view=""
      className={cn(
        "relative isolate",
        activation !== undefined && "focus-ring-from",
        className,
      )}
    >
      {activation === undefined ? (
        <Stack
          direction="row"
          gap="sm"
          align="start"
          className={fillClasses("x")}
        >
          {content}
        </Stack>
      ) : (
        <Stack
          as="button"
          direction="row"
          gap="sm"
          align="start"
          // Nominates this control as the one whose focus rings the frame.
          data-focus-ring=""
          className={cn(fillClasses("x"), "text-left outline-none")}
          {...activationProps(activation)}
        >
          {content}
          {/* The whole padded frame is the button's hit area — under the
              content, so hover still reaches it. */}
          <Layer as="span" aria-hidden className="z-under" />
        </Stack>
      )}
      {when !== undefined ? (
        <Stack gap="2xs" align="end" className={rigidClass()}>
          <Center className={HEADLINE_LINE}>
            <Text variant="caption" tone="faint">
              <RelativeTime date={when} format="short" />
            </Text>
          </Center>
          {button}
        </Stack>
      ) : (
        (button ?? dismiss) !== null && (
          <Center className={cn(rigidClass(), HEADLINE_LINE)}>
            {button ?? dismiss}
          </Center>
        )
      )}
    </Stack>
  );
}

/**
 * The toast: the same view on the overlay surface (no time — it is now). An
 * error's outline leans red.
 */
export function NotificationToastCard({
  n,
  dismiss,
}: {
  n: NotificationContent;
  /** Dismisses this toast (the × of a notification with no action). */
  dismiss: () => void;
}): ReactElement {
  return (
    <Surface
      level="overlay"
      className={cn(
        // Sonner sizes only its own styled toasts; a custom one takes the
        // toaster's `--width` itself, so a long line ellipsizes instead of
        // widening the card.
        "w-(--width) max-w-full",
        n.variant === "error" ? "ring-destructive/40" : undefined,
      )}
      data-testid="notification-toast"
    >
      <NotificationView
        n={n}
        surface="toast"
        onActed={dismiss}
        onDismiss={dismiss}
        className="py-sm pl-md pr-sm"
      />
    </Surface>
  );
}

/** Errors stay until dismissed or acted on; everything else leaves after 4s. */
export const TOAST_DURATION_MS = 4000;

/** Show `n` as a toast through the toast host's custom-content path. */
export function toastNotification(n: NotificationContent): void {
  showToast({
    render: ({ dismiss }) => <NotificationToastCard n={n} dismiss={dismiss} />,
    duration: n.variant === "error" ? Infinity : TOAST_DURATION_MS,
    audience: n.audience,
  });
}
