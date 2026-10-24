import { useEffect, useMemo, type ReactElement } from "react";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { assetUrlOver } from "@plugins/infra/plugins/endpoints/web";
import { mailImageProxyAsset } from "@plugins/apps/plugins/mail/plugins/remote-images/core";
import { processEmailHtml } from "../internal/process-email-html";
import "./mail-html.css";

export interface MailHtmlProps {
  /** Raw email HTML (e.g. `mail_messages.body_html`). */
  html: string;
  /** Whether the user has opted into loading remote images for this message. */
  showRemoteImages: boolean;
  /**
   * Called after render with whether the source referenced any remote image —
   * lets the reading pane show/hide the "Display images" affordance.
   */
  onRemoteImagesDetected?: (present: boolean) => void;
  /**
   * Resolve a bare Content-ID (no angle brackets) to an inline-attachment URL,
   * or undefined while the attachment is not yet available. Passed through
   * render, so the body re-processes (and cid placeholders fill in) as more
   * attachments hydrate.
   */
  resolveCid?: (cid: string) => string | undefined;
}

/**
 * Privacy-safe email HTML renderer. Runs the sanitize → image-gate →
 * cid-resolve → quoted-history-collapse pipeline (see process-email-html) and
 * injects the result inside a style-scoped container. The trimmed quoted
 * history starts collapsed behind a `•••` toggle.
 */
export function MailHtml({
  html,
  showRemoteImages,
  onRemoteImagesDetected,
  resolveCid,
}: MailHtmlProps): ReactElement {
  const transport = useTransport();
  const processed = useMemo(() => {
    // An `<img src>` inside the HTML string loads by URL, so each proxied src
    // is the asset's URL over this subtree's transport. Where the proxy is
    // unavailable (a host without the computer) the image stays stripped — the
    // privacy-safe answer; the opt-in is not offered there in the first place
    // (`RemoteImagesNotice` shows the unavailable message instead).
    const remoteImageSrc = showRemoteImages
      ? (remoteUrl: string) => {
          const url = assetUrlOver(transport, mailImageProxyAsset(remoteUrl));
          return url.kind === "ready" ? url.url : null;
        }
      : null;
    return processEmailHtml(html, { remoteImageSrc, resolveCid });
  }, [html, showRemoteImages, resolveCid, transport]);

  const quoted = useCollapsible();

  useEffect(() => {
    onRemoteImagesDetected?.(processed.hadRemoteImage);
  }, [processed.hadRemoteImage, onRemoteImagesDetected]);

  return (
    <div className="mail-html-body">
      <div dangerouslySetInnerHTML={{ __html: processed.mainHtml }} />
      {processed.quotedHtml !== null && (
        <>
          <button
            {...quoted.triggerProps}
            className="mail-html-quote-toggle"
            aria-label={
              quoted.open ? "Hide trimmed content" : "Show trimmed content"
            }
          >
            {quoted.open ? "Hide trimmed content" : "•••"}
          </button>
          <FoldMotion {...quoted.contentProps}>
            <div
              className="mail-html-quoted"
              dangerouslySetInnerHTML={{ __html: processed.quotedHtml }}
            />
          </FoldMotion>
        </>
      )}
    </div>
  );
}
