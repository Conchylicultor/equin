import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataProgress } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import {
  sectionsChapters,
  sectionsDescribe,
  sectionsLabels,
} from "./contributions";

export default {
  description:
    "Sonata progress sections: the song's 'section' annotations as the progression bar's chapters (rail segments), as labels in its label lane (coloured dot + name, current one strong, click to seek, hover to loop the section) and as the '● name' line of its hover preview.",
  contributions: [
    SonataProgress.Chapters({ id: "sections", chapters: sectionsChapters }),
    SonataProgress.Label({ id: "sections", order: 0, labels: sectionsLabels }),
    SonataProgress.Describe({
      id: "sections",
      order: 0,
      line: "body",
      describe: sectionsDescribe,
    }),
  ],
} satisfies PluginDefinition;
