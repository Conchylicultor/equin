import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  pagesTree,
  pageData,
  type PageRow,
} from "@plugins/page/plugins/editor/core";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { INERT_ACTIVATION } from "../internal/inert-activation";

const linkIcon = symbol("link");

/**
 * Read-only equivalent of the editor's inline page-link chip
 * (`PageLinkInlineView`). Resolves the linked page's title + icon from its live
 * row in `pagesTree` and renders the same `LinkChip` shape — but never navigates
 * (a static render declares no page navigation), so its activation is inert:
 * the chip still isolates its click from whatever holds it. The preview layer
 * stays inert by design.
 *
 * It lives HERE, with the family that declares the token, rather than in
 * `read-only-view` — which used to own it and to name this token type by hand.
 * A read-only surface reaches it through `renderToken` on the registration in
 * `../internal/register`, so the surface names no token family at all and a new
 * one cannot be forgotten there.
 */
export function PageLinkChip({ pageId }: { pageId: string }) {
  const result = useLiveRow(pagesTree, pageId);

  // A failed read that once had the page keeps resolving from it; without
  // one, the chip is the failure (an icon, to keep the line intact).
  let target: PageRow | undefined;
  switch (result.status) {
    case "loading":
      // Show the raw token-free title placeholder rather than nothing, so the
      // line height stays stable while the row loads.
      return (
        <LinkChip activation={INERT_ACTIVATION}>
          <Placeholder>…</Placeholder>
        </LinkChip>
      );
    case "error":
      if (result.stale === undefined) {
        return (
          <ResourceErrorInline
            error={result.error}
            refetch={result.refetch}
            variant="icon"
            icon={linkIcon}
            subject="the linked page"
          />
        );
      }
      target = result.stale;
      break;
    case "ready":
      target = result.found ? result.row : undefined;
  }

  const data = target ? pageData(target) : undefined;

  if (!target) {
    return (
      <LinkChip activation={INERT_ACTIVATION}>
        <Placeholder>(page not found)</Placeholder>
      </LinkChip>
    );
  }

  return (
    <LinkChip
      leading={
        <Center as="span" className="size-3.5">
          <PageIcon
            icon={data?.icon}
            fallback={linkIcon}
            className="size-3.5"
          />
        </Center>
      }
      activation={INERT_ACTIVATION}
    >
      {data?.title || "Untitled"}
    </LinkChip>
  );
}
