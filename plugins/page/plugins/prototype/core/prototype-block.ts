import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/** The Prototypes app's own mark: the block opens that app's canvas. */
export const PROTOTYPE_BLOCK_ICON = symbol("dashboard-customize");

/** A `width` / `height` attribute: a whole number of px, or absent. */
function sizeAttr(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `markdown: <prototype ${name}="${raw}"/> — \`${name}\` must be a positive whole number of px.`,
    );
  }
  return value;
}

export const prototypeBlock = defineBlock({
  type: "prototype",
  // `""` is the freshly inserted block, still asking which prototype it shows.
  // `width` / `height` are the frame's size in px, set by dragging its edges:
  // without a width it fills the block, without a height it is 16:9 of its
  // width.
  schema: z.object({
    prototypeId: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  label: "Prototype",
  icon: PROTOTYPE_BLOCK_ICON,
  aliases: ["mock", "mockup", "design", "proto"],
  empty: () => ({ prototypeId: "" }),
  // `<prototype id="proto-…"/>` — how an agent links the mock it just built
  // into a page. `body: "none"`: the content lives in the prototype's folder,
  // so a body is a loud rejection rather than a silent drop.
  //
  // `title` is ANNOTATED — read-only, supplied by this plugin's server
  // (`Editor.BlockAnnotation`) from the prototype's `<title>`, discarded on
  // parse — so an agent reading the page knows which mock a line shows
  // without opening it.
  markdown: {
    tag: {
      name: "prototype",
      body: "none",
      annotated: ["title"],
      attrs: (data) => ({
        id: data.prototypeId,
        width: data.width,
        height: data.height,
      }),
      parseAttrs: (attrs) => {
        const id = attrs.id;
        if (id === undefined || id === "") {
          throw new Error(
            'markdown: <prototype/> needs an `id` — the prototype\'s id, `<prototype id="proto-…"/>`.',
          );
        }
        if (!protoIdKind.is(id)) {
          throw new Error(
            `markdown: <prototype id="${id}"/> — \`id\` must be a prototype id (\`proto-…\`, as \`./equin prototype new\` prints it).`,
          );
        }
        const width = sizeAttr(attrs.width, "width");
        const height = sizeAttr(attrs.height, "height");
        return {
          prototypeId: id,
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        };
      },
    },
  },
});
