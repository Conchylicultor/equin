import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  WebsiteArrow,
  WebsiteBand,
} from "@plugins/apps/plugins/website/plugins/shell/web";
import { storyPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/web";

const PROMPT = "Curious how equin came to be?";
const LINK = "Read the full story and context";

/**
 * The band between the layers and the contact block: one line offering the
 * story page to a reader who wants the context behind the project.
 *
 * It is a sentence with a link in it, not a call to action — the layer cards above
 * are the page's real choices, and this must not compete with them. Which is why
 * it is one centred line on its own rule, and why the link is the `inline`
 * aspect of a `link` button — it takes the sentence's own size and sits in its
 * flow, underlined in the quiet grey, coming up to full foreground on hover —
 * rather than anything boxed or filled.
 */
export function StoryLinkSection() {
  const openPane = useOpenPane();
  return (
    <WebsiteBand
      section="story-link"
      divider
      rhythm="interlude"
      className="text-center"
    >
      <Text as="p" variant="subheading" tone="muted" className="font-normal">
        {PROMPT}{" "}
        <Button
          variant="link"
          aspect="inline"
          className="text-foreground decoration-muted-foreground/60 hover:decoration-foreground underline"
          {...openPane.link(storyPane, {}, { mode: "root" })}
        >
          {LINK}
          <WebsiteArrow />
        </Button>
      </Text>
    </WebsiteBand>
  );
}
