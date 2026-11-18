import type { ComponentProps, ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { GATEWAY_PORT_RANGE } from "@plugins/infra/plugins/namespace/core";
import {
  localAppHost,
  localAppPortFor,
  localAppUrl,
} from "@plugins/apps/plugins/website/plugins/shell/core";
import "./download.css";

/**
 * A link inside a sentence of the download page — the local app's address. The `inline` aspect of a `link` button, like the homepage's story
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

/** The page's own location, when it is a page of a local instance; read live. */
const readLocalAppPort = (): number => localAppPortFor(window.location);

/**
 * The local app's address as a {@link DownloadLink}: on a local instance, the
 * port this page was served on; on equin.ai (and in the static render robots
 * read), the port a fresh install takes — the site cannot know a visitor's.
 */
export function LocalAppLink() {
  const port = useBrowserValue({
    name: "local app port",
    read: readLocalAppPort,
    staticValue: GATEWAY_PORT_RANGE.first,
  });
  return (
    <DownloadLink href={localAppUrl(port)}>{localAppHost(port)}</DownloadLink>
  );
}
