import type { LexicalNode } from "lexical";
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
import { usePageNavigation } from "@plugins/page/plugins/page-reference/web";
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
  const result = useLiveRow(pagesTree, pageId);

  // A failed read that once had the page keeps resolving from it; without
  // one, the chip is the failure (an icon, to keep the line intact).
  let target: PageRow | undefined;
  switch (result.status) {
    case "loading":
      // Render nothing while the page row is loading.
      return null;
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
      // A link: ⌘/middle-click opens the page in a new browser tab. The chip
      // isolates the click, so it never also lands in the editor around it.
      activation={nav?.open(pageId) ?? INERT_ACTIVATION}
    >
      {data?.title || "Untitled"}
    </LinkChip>
  );
}

export function $createPageLinkInlineNode(pageId: string): LexicalNode {
  return pageLinkInlineWebNode.create({ pageId });
}
