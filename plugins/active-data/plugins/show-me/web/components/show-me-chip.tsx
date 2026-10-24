import { useState, type ReactNode } from "react";
import { pointAt } from "@plugins/hints/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { resolveUiContext } from "@plugins/primitives/plugins/ui-context/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const targetIcon = symbol("my-location");
const goneIcon = symbol("location-disabled");

const NOT_HERE = "Not on this page";

/**
 * The chip a `<show-me path element>label</show-me>` draws: the label behind
 * a target. A click finds the element NOW (`resolveUiContext` — the page may
 * have changed since the agent read its outline) and spotlights it
 * (`pointAt`, the label as caption). When nothing on the page matches, the
 * chip says so — in a toast and, from then on, its own look and tooltip — and
 * nothing is spotlit. A tag without `element` cannot name anything: it draws
 * as such rather than as a chip that does nothing.
 *
 * One step: Next is not offered (stepping through a message's other show-me
 * tags would need the message, which an inline renderer is not handed).
 */
function ShowMeChip({
  attrs,
  label,
  children,
}: {
  attrs: Record<string, string>;
  /** The caption: the tag's text. */
  label: string;
  children: ReactNode;
}) {
  const [gone, setGone] = useState(false);
  const element = attrs.element;
  if (!element) {
    return (
      <LinkChip
        tooltip="This show-me names no element (its element attribute is missing)"
        leading={<ChipIcon gone />}
        activation={() => {
          throw new Error(
            `<show-me> without an element attribute: ${JSON.stringify(attrs)}`,
          );
        }}
      >
        {children}
      </LinkChip>
    );
  }
  const show = () => {
    const found = resolveUiContext({ path: attrs.path ?? "", element });
    if (found.kind === "gone") {
      setGone(true);
      showToast({ title: NOT_HERE, description: label, variant: "info" });
      return;
    }
    setGone(false);
    pointAt(() => found.el, { body: label });
  };
  return (
    <LinkChip
      className={cn("max-w-60", gone && "text-muted-foreground")}
      tooltip={gone ? `${NOT_HERE} — click to look again` : `Show me: ${label}`}
      leading={<ChipIcon gone={gone} />}
      activation={show}
    >
      {children}
    </LinkChip>
  );
}

function ChipIcon({ gone }: { gone: boolean }) {
  return (
    <Icon
      icon={gone ? goneIcon : targetIcon}
      className={cn("text-muted-foreground", rigidClass())}
    />
  );
}

/** `<show-me …>label</show-me>` in a paragraph's flow. */
export function ShowMeInline({
  content,
  attrs,
  children,
}: {
  content: string;
  attrs: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <ShowMeChip attrs={attrs} label={content}>
      {children}
    </ShowMeChip>
  );
}

/** The same tag written across lines (block form): the label is its text. */
export function ShowMeBlock({
  content,
  attrs,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  return (
    <ShowMeChip attrs={attrs} label={content}>
      {content}
    </ShowMeChip>
  );
}
