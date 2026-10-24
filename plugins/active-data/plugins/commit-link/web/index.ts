import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActiveData, codeTag } from "@plugins/active-data/web";
import {
  CommitLinkChip,
  PendingCommitChip,
} from "./components/commit-link-chip";
import { useCommitClaim } from "./internal/use-commit-claim";
import { COMMIT_SHA_RE } from "./internal/pattern";

export default {
  description:
    "Renders commit shas in backtick-wrapped inline code as clickable chips that open the commit-detail pane, with the subject, author and date on hover. Resolves the sha against the main checkout's object database and declines when it names no commit.",
  contributions: [
    ActiveData.Tag(
      codeTag({
        id: "commit-link",
        pattern: COMMIT_SHA_RE,
        useClaim: useCommitClaim,
        component: CommitLinkChip,
        pending: PendingCommitChip,
      }),
    ),
  ],
} satisfies PluginDefinition;
