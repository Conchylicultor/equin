import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/** The Prototypes app's own mark: the block opens that app's canvas. */
export const PROTOTYPE_BLOCK_ICON = symbol("dashboard-customize");

export const prototypeBlock = defineBlock({
  type: "prototype",
  // `""` is the freshly inserted block, still asking which prototype it shows.
  schema: z.object({ prototypeId: z.string() }),
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
      attrs: (data) => ({ id: data.prototypeId }),
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
        return { prototypeId: id };
      },
    },
  },
});
