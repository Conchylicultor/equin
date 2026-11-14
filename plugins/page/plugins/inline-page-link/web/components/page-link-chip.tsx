import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { usePageReferent } from "@plugins/page/plugins/page-reference/web";
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
  const referent = usePageReferent(pageId);

  switch (referent.state) {
    case "pending":
      return (
        <LinkChip activation={INERT_ACTIVATION}>
          <Placeholder>…</Placeholder>
        </LinkChip>
      );
    // Without a page ever seen, the chip is the failure (an icon, to keep
    // the line intact).
    case "failed":
      return (
        <ResourceErrorInline
          error={referent.error}
          refetch={referent.refetch}
          variant="icon"
          icon={linkIcon}
          subject="the linked page"
        />
      );
    case "missing":
      return (
        <LinkChip activation={INERT_ACTIVATION}>
          <Placeholder>(page not found)</Placeholder>
        </LinkChip>
      );
    case "live":
    case "trashed":
      break;
  }

  const data = referent.data;
  // A page in the trash keeps its name, struck through.
  const trashed = referent.state === "trashed";

  return (
    <LinkChip
      leading={
        <Center as="span" className="size-3.5">
          <PageIcon icon={data.icon} fallback={linkIcon} className="size-3.5" />
        </Center>
      }
      activation={INERT_ACTIVATION}
    >
      {trashed ? (
        <span
          className="text-muted-foreground line-through"
          title="This page is in the trash"
        >
          {data.title || "Untitled"}
        </span>
      ) : (
        data.title || "Untitled"
      )}
    </LinkChip>
  );
}
