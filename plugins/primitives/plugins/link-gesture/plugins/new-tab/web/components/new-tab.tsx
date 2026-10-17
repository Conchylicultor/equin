import type {
  ComponentProps,
  CSSProperties,
  MouseEvent,
  ReactNode,
} from "react";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Button,
  DropdownMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";

/**
 * Where the new browser tab goes: an app path of this origin (`/proto/x`) or an
 * absolute URL. A thunk when the destination is only known at click time (a
 * frame's current version), evaluated synchronously inside the click so
 * `window.open` is still a user gesture.
 */
export type NewTabHref = string | (() => string);

const DEFAULT_LABEL = "Open in a new tab";

function open(href: NewTabHref): void {
  openInBrowserTab(typeof href === "function" ? href() : href);
}

/**
 * Opens without activating whatever the control sits in (a clickable row, a
 * card): a new-tab control never ALSO navigates its container.
 */
function openIsolated(href: NewTabHref) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    open(href);
  };
}

/**
 * The new-tab glyph, drawn by every control below. The one place
 * `navIcons.newTab` is read: pairing the arrow with anything but a browser tab
 * has no spelling.
 */
// eslint-disable-next-line new-tab/no-adhoc-new-tab -- this IS the primitive that owns the glyph
const NEW_TAB_ICON = navIcons.newTab;

type ButtonVariant = ComponentProps<typeof Button>["variant"];

interface NewTabButtonCommon {
  /** `undefined` when there is nothing to open: the button is disabled. */
  href: NewTabHref | undefined;
  disabled?: boolean;
  variant?: ButtonVariant;
  className?: string;
  style?: CSSProperties;
}

export type NewTabButtonProps = NewTabButtonCommon &
  (
    | {
        /** Icon-only form: the tooltip + aria-label. Defaults to "Open in a new tab". */
        label?: string;
        /** Icon-only form: a richer tooltip than the label (the URL it opens). */
        tooltip?: ReactNode;
        children?: never;
      }
    | {
        /** Text form: the visible words, after the glyph. */
        children: ReactNode;
        label?: never;
        tooltip?: never;
      }
  );

/**
 * A button that opens `href` in a new BROWSER tab, wearing the new-tab arrow.
 * Without `children` it is an {@link IconButton} (ghost by default); with them
 * it is a text button, the glyph leading. It takes no `onClick`: the behaviour
 * is the point of the component, so a caller cannot make the arrow do anything
 * else (a new app tab wears `navIcons.newAppTab` instead).
 */
export function NewTabButton(props: NewTabButtonProps) {
  const { href, variant, className, style } = props;
  const disabled = props.disabled === true || href === undefined;
  const onClick = href === undefined ? undefined : openIsolated(href);
  if (props.children === undefined) {
    return (
      <IconButton
        icon={NEW_TAB_ICON}
        label={props.label ?? DEFAULT_LABEL}
        tooltip={props.tooltip}
        variant={variant}
        disabled={disabled}
        className={className}
        style={style}
        onClick={onClick}
      />
    );
  }
  return (
    <Button
      variant={variant}
      disabled={disabled}
      className={className}
      style={style}
      onClick={onClick}
    >
      <Icon icon={NEW_TAB_ICON} />
      {props.children}
    </Button>
  );
}

/**
 * A menu entry that opens `href` in a new browser tab. With `children` the
 * glyph leads the words; without, it is a bare glyph item named by `label`
 * (a trailing icon beside a row's main entry). `href: undefined` disables it,
 * saying why in the tooltip.
 */
export function NewTabMenuItem({
  href,
  label = DEFAULT_LABEL,
  unavailableReason = "not available here",
  children,
  className,
}: {
  href: NewTabHref | undefined;
  label?: string;
  unavailableReason?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <DropdownMenuItem
      aria-label={children === undefined ? label : undefined}
      title={href === undefined ? `${label} — ${unavailableReason}` : label}
      disabled={href === undefined}
      onClick={href === undefined ? undefined : () => open(href)}
      className={className}
    >
      <Icon icon={NEW_TAB_ICON} />
      {children}
    </DropdownMenuItem>
  );
}

/**
 * The props that make an anchor open `href` in a new browser tab — for a
 * component rendered AS a link (`<Badge as="a">`, `<Button render={<a/>}>`).
 * The click stops at the anchor, so its container is not activated too.
 */
export function newTabAnchorProps(href: string) {
  return {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (e: MouseEvent) => e.stopPropagation(),
  } as const;
}

/**
 * An inline text link opening `href` in a new browser tab: the words, then the
 * glyph. A real `<a>`, so the browser's own link gestures and context menu
 * apply.
 */
export function NewTabLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a {...newTabAnchorProps(href)} className={className}>
      <Inline gap="2xs">
        {children}
        <Icon icon={NEW_TAB_ICON} className="icon-auto" />
      </Inline>
    </a>
  );
}

/**
 * The bare glyph, for a mark whose CONTAINER opens the browser tab: a row
 * whose activation is a {@link newTabAnchorProps} / `openInBrowserTab` link, a
 * hover hint over a thumbnail that is one, an `<a>`-rendered chip's leading
 * icon. Never on a control that does something else — that control is a
 * {@link NewTabButton} or wears another glyph.
 */
export function NewTabGlyph({ className }: { className?: string }) {
  return <Icon icon={NEW_TAB_ICON} className={className} />;
}
