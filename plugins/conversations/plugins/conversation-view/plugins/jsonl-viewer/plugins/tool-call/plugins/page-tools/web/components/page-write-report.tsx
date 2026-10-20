import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import type { PageApplyReport } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/core";

/**
 * What the write did to the page, one chip per kind of change.
 *
 * Only the arms that carry information are painted — a write that created
 * nothing says nothing about creation. The exception is `no change`: a write
 * that moved nothing is a real outcome (the agent re-sent a document it had
 * already applied), and leaving it blank would read as a rendering gap rather
 * than as the answer.
 */
export function PageWriteReport({
  report,
}: {
  report: PageApplyReport | null;
}) {
  if (!report) return null;

  const {
    survived,
    created,
    deleted,
    moved,
    text_edited: rewritten,
    replaced,
  } = report;
  const noteIds = report.note_ids ?? [];
  const noChange =
    created === 0 && rewritten === 0 && deleted === 0 && moved === 0;

  return (
    <Cluster>
      {created > 0 && <Badge variant="success">+{created} added</Badge>}
      {rewritten > 0 && <Badge variant="info">{rewritten} rewritten</Badge>}
      {deleted > 0 && <Badge variant="destructive">−{deleted} deleted</Badge>}
      {moved > 0 && <Badge variant="muted">{moved} moved</Badge>}
      {/* "no change" already says the whole thing; pairing it with a survivor
          count would read as two answers to one question. */}
      {noChange ? (
        <Badge variant="muted">no change</Badge>
      ) : (
        <Badge variant="muted">{survived} unchanged</Badge>
      )}
      {noteIds.length > 0 && (
        <Badge variant="muted" tooltip={noteIds.join("\n")}>
          {noteIds.length} note {noteIds.length === 1 ? "card" : "cards"}
        </Badge>
      )}
      {/* Only above 1: "replaced ×1" is what every ordinary edit does. */}
      {replaced != null && replaced > 1 && (
        <Badge variant="muted">replaced ×{replaced}</Badge>
      )}
    </Cluster>
  );
}
