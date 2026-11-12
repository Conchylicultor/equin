import type { ComponentProps, ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import "./download.css";

/**
 * A link inside a sentence of the download page — the local app's address, the
 * guide. The `inline` aspect of a `link` button, like the homepage's story
 * link: it takes the sentence's size and flow, underlined in the quiet grey,
 * and comes up to full foreground on hover.
 */
type Gesture = Pick<
  ComponentProps<typeof Button>,
  "onClick" | "onAuxClick" | "onMouseDown"
>;

export function DownloadLink({
  href,
  children,
  ...gesture
}: {
  children: ReactNode;
} & (
  | { href: string; onClick?: never; onAuxClick?: never; onMouseDown?: never }
  | ({ href?: never } & Gesture)
)) {
  return (
    <Button
      variant="link"
      aspect="inline"
      className="download-link text-foreground decoration-muted-foreground/60 hover:decoration-foreground underline"
      {...gesture}
      render={
        href === undefined ? undefined : (
          <a href={href} target="_blank" rel="noreferrer noopener" />
        )
      }
    >
      {children}
    </Button>
  );
}
