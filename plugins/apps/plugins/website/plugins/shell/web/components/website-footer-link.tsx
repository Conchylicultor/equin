import type { ComponentProps } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * What an in-app link spreads (`openPane.link`): its click handlers, and in
 * a static render the destination a robot reads (`data-link`).
 */
type LinkGesture = Pick<
  ComponentProps<typeof Button>,
  "onClick" | "onAuxClick" | "onMouseDown"
> & { "data-link"?: string };

/**
 * One quiet link in the site footer (a `Website.FooterLink` contribution):
 * the small print's grey, coming up to full foreground on hover — the same
 * treatment as the footer's address beside it. A link button, since an in-app
 * link is click handlers rather than an href: it keeps the pointer cursor,
 * the focus ring and the ⌘-click to a new tab.
 */
export function WebsiteFooterLink({
  label,
  ...gesture
}: { label: string } & LinkGesture) {
  return (
    <Button
      variant="link"
      aspect="inline"
      className="text-faint-foreground hover:text-foreground hover:no-underline"
      {...gesture}
    >
      <Text variant="caption">{label}</Text>
    </Button>
  );
}
