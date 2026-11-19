import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import {
  usePageNavigation,
  usePageReferent,
} from "@plugins/page/plugins/page-reference/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { INERT_ACTIVATION } from "../internal/inert-activation";

const linkIcon = symbol("link");

/**
 * THE chip of an inline page link — the one rendering of `[[page:<pageId>]]`,
 * painted by the Lexical decorator (`page-link-inline-node.tsx`, inside its
 * `TokenFrame`) and by `renderToken` on every surface that mounts no Lexical
 * (a dormant text block, page history, diffs, the public site).
 *
 * There used to be two: an editor chip that navigated and a "read-only" twin
 * whose activation was hard-wired inert, on the theory that a static render
 * declares no navigation. But a DORMANT block of the live editor is a static
 * render too, so every page link in a line you were not typing in did nothing
 * when clicked. Whether a chip can navigate is the host's answer, not the
 * renderer's: both read `usePageNavigation()`, and a surface that declares none
 * (a version diff, the public site) gets the inert chip on its own.
 *
 * Inert or not, the chip keeps an activation: `LinkChip` isolates its click, so
 * pressing it never also activates the block or row around it.
 */
export function PageLinkChip({ pageId }: { pageId: string }) {
  const nav = usePageNavigation();
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
      // A link: ⌘/middle-click opens the page in a new browser tab.
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
