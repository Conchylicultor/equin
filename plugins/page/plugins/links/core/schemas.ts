import { z } from "zod";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";

// Where the link sits in the source page: an excerpt of the linking block's
// text as a person reads it (inline tokens shown as their titles), split around
// the target's title so the view can mark it. `before` / `after` are already
// trimmed to a short window around the match, with `…` where text was cut.
export const BacklinkSnippetSchema = z.object({
  before: z.string(),
  match: z.string(),
  after: z.string(),
});
export type BacklinkSnippet = z.infer<typeof BacklinkSnippetSchema>;

// One referencing (source) page in a target page's backlinks list. Carries
// just enough to render a clickable row: the source page's id, title, and the
// page's icon (an emoji; null when the page has no icon), where it sits in the
// page tree (`path`: its ancestor pages' titles, root first; empty for a root
// page), plus the snippet of
// its FIRST linking block in document order — null when that block IS the link
// (a page-link block, whose only text is the target's name) or its text never
// names the target.
export const BacklinkRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: EmojiSchema.nullable(),
  path: wholeList(z.string(), {
    reason: "one page's ancestors — as deep as the page tree nests",
  }),
  snippet: BacklinkSnippetSchema.nullable(),
});
export type BacklinkRow = z.infer<typeof BacklinkRowSchema>;

// Where the page's link to each target is written, for the targets linked
// from a block with a place in the page tree (a link-to-page block): the
// linking block's `doc_rank` — the same rank space as the page's sub-pages,
// so the sidebar draws the alias among them. A target linked only inline
// (a `[[mention]]` in a line of text) has no entry; a target linked by
// several placed blocks keeps the FIRST in document order.
export const LinkRanksSchema = wholeRecord(z.string(), {
  reason:
    "one page's placed links, one rank per page it links to — as many as linksTo",
});

// One live page and the pages it links TO: the distinct target pages of its
// `page_links` edges, a self-link excluded, in id order (`[]` for a page that
// links nowhere), and where each placed link sits (`linkRanks`). The row of
// `pageLinkTargets` — the pages sidebar draws each target as a reference child
// of the page, at its link.
export const PageLinkTargetsRowSchema = z.object({
  id: z.string(),
  linksTo: z.array(z.string()),
  linkRanks: LinkRanksSchema,
});

export type PageLinkTargetsRow = z.infer<typeof PageLinkTargetsRowSchema>;
