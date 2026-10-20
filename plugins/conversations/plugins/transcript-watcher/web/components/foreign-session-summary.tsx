import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ForeignSessionPayloadSchema } from "@plugins/conversations/plugins/transcript-source/core";

// One-line summary for the Debug, Reports list, e.g.
// "`conv-1786969506-7e03` holds 2bf76e71 — it lives in …-att-1787096858-0t1l,
// not …-att-1786969505-xoj5". Session ids shorten to their first segment and
// directories to their basename (the full values live in the filed task) so the
// row stays readable at list width.
export function ForeignSessionSummary({ report }: { report: Report }) {
  const parsed = ForeignSessionPayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.conversationId}
      </Badge>
      {d.reason === "directory-mismatch" ? (
        <span>
          holds {shortId(d.foreignSessionId)} — it lives in{" "}
          {baseName(d.foreignDir)}, not {baseName(d.anchorDir)}
        </span>
      ) : (
        <span>
          shares {shortId(d.foreignSessionId)} with{" "}
          {d.otherConversationIds.length === 1
            ? d.otherConversationIds[0]
            : `${d.otherConversationIds.length} other conversations`}
        </span>
      )}
    </Inline>
  );
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// `~/.claude/projects/<dir>` — the leaf is the encoded worktree path, which is
// the only part that distinguishes one conversation's transcripts from another's.
function baseName(dir: string): string {
  return dir.slice(dir.lastIndexOf("/") + 1);
}
