import {
  blockTextTokenExtension,
  registerBlockTextExtension,
} from "@plugins/page/plugins/editor/web";
import { MENTION_TOKEN_PATTERN } from "../../core";
import { dateMentionWebNode } from "../components/date-mention-node";
import { DateMentionChip } from "../components/date-mention-chip";
import { InlineDatePlugin } from "../components/inline-date-plugin";

// Side-effect: teach every block text editor about inline date mentions — the
// node (whose two token kinds are declared once in `core/node.ts`, branched by
// capture group), the combined `[[date:…]]` / `[[reminder:…]]` pattern, the `@`
// typeahead, and how the token paints on a surface that mounts no Lexical (page
// history, diffs, the public site) — which until now it did not, so it showed
// there as the literal characters `[[date:2026-08-25T…]]`.
registerBlockTextExtension(
  blockTextTokenExtension({
    id: "date-mention",
    node: dateMentionWebNode,
    pattern: MENTION_TOKEN_PATTERN,
    // `[[date:…]]` / `[[reminder:…]]` are made of brackets, which the inline
    // scan reads as a markdown link — so its bytes must be masked out of it.
    markdownSpan: "protect",
    renderToken: ({ iso, reminderId }) => (
      <DateMentionChip
        iso={iso}
        reminderId={reminderId}
        // A no-op action: LinkChip isolates it, so the press stops here
        // rather than reaching the surface the token is rendered in.
        activation={() => {}}
      />
    ),
    Plugin: InlineDatePlugin,
  }),
);
