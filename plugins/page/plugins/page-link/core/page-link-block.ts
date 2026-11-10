import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { typeVar } from "@plugins/primitives/plugins/css/plugins/text/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const linkIcon = symbol("link");

export const pageLinkBlock = defineBlock({
  type: "page-link",
  schema: z.object({ pageId: z.string() }),
  label: "Link to page",
  icon: linkIcon,
  aliases: ["link", "reference", "subpage"],
  empty: () => ({ pageId: "" }),
  // `<page id="x"/>` — the SAME tag name a sub-page serializes to, and this
  // handle is the one that owns it on PARSE (the sub-page's tag is
  // `serializeOnly`). So a copied sub-page pastes back as a pointer at the same
  // page rather than as a second copy of its content — the only thing a markdown
  // parse can honestly mint. `body: "none"`: this block's content lives in
  // another page, so a body is a loud rejection rather than a silent drop.
  //
  // `title` is ANNOTATED — read-only, supplied by this plugin's server
  // (`Editor.BlockAnnotation`) from the TARGET page's row, and discarded on
  // parse. It is the sub-page spelling's annotation too, so an agent reading
  // `<page id="…" title="…"/>` can tell pages apart without opening each one,
  // whichever of the two kinds of row wrote the line.
  markdown: {
    tag: {
      name: "page",
      body: "none",
      annotated: ["title"],
      attrs: (data) => ({ id: data.pageId }),
      parseAttrs: (attrs) => {
        const id = attrs.id;
        if (id === undefined || id === "") {
          throw new Error(
            "markdown: <page/> needs an `id` — a link to nothing is not a link.",
          );
        }
        return { pageId: id };
      },
    },
  },
  // An icon+title Row (not doc text), wrapped in `py-xs`: seat the rail on the
  // Row's center — its own `pad-row-y` top plus half a `text-body` line.
  gutterFirstLineCenter: `calc(var(--space-xs) + var(--pad-row-y) + ${typeVar("line-height-body")} / 2)`,
  // Always show the collapse chevron: a collapsed link mounts no children, so
  // `hasChildren` is false and without this no chevron would ever appear.
  collapsible: "always",
  // The sidebar draws the linked page under this one, AT the link: the block
  // takes a `doc_rank` among the page's sub-pages, so the reference sits
  // where the link is written rather than after every sub-page.
  pageTreePlace: true,
});
