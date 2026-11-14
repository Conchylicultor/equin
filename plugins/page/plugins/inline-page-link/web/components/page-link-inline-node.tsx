import type { LexicalNode } from "lexical";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import {
  usePageNavigation,
  usePageReferent,
} from "@plugins/page/plugins/page-reference/web";
import { pageLinkInlineNode } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { INERT_ACTIVATION } from "../internal/inert-activation";

const linkIcon = symbol("link");

/**
 * The browser half of the inline page-link token: the SAME family declared in
 * `core/node.ts`, with rendering added. Everything structural — the type string,
 * the `__pageId` property, the token format, the empty `getTextContent()` — is
 * inherited from that one declaration.
 */
export const pageLinkInlineWebNode = pageLinkInlineNode.decorated({
  className: "inline-flex align-baseline",
  render: ({ pageId }) => <PageLinkInlineView pageId={pageId} />,
});

/** The Lexical class to register in a block editor's `nodes` config. */
export const PageLinkInlineNode = pageLinkInlineWebNode.Node;

function PageLinkInlineView({ pageId }: { pageId: string }) {
  const nav = usePageNavigation();
  const referent = usePageReferent(pageId);

  switch (referent.state) {
    case "pending":
      return null;
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
      // A link: ⌘/middle-click opens the page in a new browser tab. The chip
      // isolates the click, so it never also lands in the editor around it.
      activation={nav?.open(pageId) ?? INERT_ACTIVATION}
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

export function $createPageLinkInlineNode(pageId: string): LexicalNode {
  return pageLinkInlineWebNode.create({ pageId });
}
