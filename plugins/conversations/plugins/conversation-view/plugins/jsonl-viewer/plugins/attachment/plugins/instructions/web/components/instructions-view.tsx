import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const menuBookIcon = symbol("menu-book");

interface InstructionFile {
  path?: string;
  /** The harness's own word for where the file came from — "Project" for a repo
   *  CLAUDE.md. Shown as-is; it is a label, not a closed set of ours. */
  type?: string;
  content?: string;
}

interface InstructionsPayload {
  type: "instructions";
  files?: InstructionFile[];
  /** Paths that were loaded before and are gone now. Present only on a re-read. */
  removed?: string[];
  /** Whether the re-read found a difference. Present only on a re-read. */
  changed?: boolean;
  /** Why the harness re-read the instruction files ("session_start"). Its
   *  presence is what makes this payload a re-read rather than a snapshot. */
  reason?: string;
}

const REASON_TEXT: Record<string, string> = {
  session_start: "Instruction files were re-read when this session started.",
};

/**
 * The instruction files (CLAUDE.md) the harness loaded. The sibling
 * `nested-memory` renderer is the same idea for ONE file picked up mid-session,
 * and this is its plural twin — same card, same `FilePath`, same capped
 * pre-wrapped body — so the two read as one family rather than as two
 * unrelated rows.
 *
 * The payload comes in two flavors, and the difference matters:
 *
 * - The **launch snapshot** carries `files` alone. It is the whole point of the
 *   row, so an empty one is a broken payload and throws.
 * - The **re-read report** (any of `reason` / `removed` / `changed`) is a
 *   delta: it says what the instruction set looks like now and which paths
 *   dropped out. `files` may legitimately be empty there — a re-read whose only
 *   news is a removal — so it renders the removals in the `−` grammar the other
 *   delta cards use, and a report with nothing in it says "No changes." rather
 *   than crashing the row.
 *
 * Collapsed by default: the content is long and standing, so the collapsed line
 * answers "which files, how many" and the body waits for a reader who asks.
 */
export function InstructionsView({ event }: AttachmentRendererProps) {
  const payload = event.attachment as InstructionsPayload;
  const files = payload.files ?? [];
  const removed = payload.removed ?? [];
  // A re-read announces itself with `reason` / `removed` / `changed`; a launch
  // snapshot carries none of the three.
  const isReread =
    payload.reason !== undefined ||
    payload.removed !== undefined ||
    payload.changed !== undefined;

  if (!isReread && files.length === 0) {
    throw new Error("instructions attachment carries no `files`");
  }

  const counts = [
    files.length > 0
      ? `${files.length} file${files.length === 1 ? "" : "s"}`
      : null,
    removed.length > 0 ? `${removed.length} removed` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // With a single file and nothing removed the path belongs on the collapsed
  // line, where it identifies the row; the body then never repeats it. A
  // removal is the row's actual news, so it keeps the header for the count.
  const asidePath =
    files.length === 1 && removed.length === 0 ? files[0]?.path : undefined;

  return (
    <CollapsibleCard
      icon={<Icon icon={menuBookIcon} className="size-3.5" />}
      label="Project instructions"
      note={`· ${counts || "no changes"}`}
      aside={asidePath ? <FilePath filePath={asidePath} /> : undefined}
    >
      <Stack gap="sm">
        {files.length === 0 && removed.length === 0 && !payload.reason && (
          <Text
            as="p"
            variant="caption"
            className="text-muted-foreground/60 italic"
          >
            No changes.
          </Text>
        )}
        {payload.reason && (
          <Text
            as="p"
            variant="caption"
            className="text-muted-foreground/60 italic"
          >
            {REASON_TEXT[payload.reason] ??
              `Instruction files were re-read (${payload.reason}).`}
          </Text>
        )}
        {files.map((file, index) => (
          <Stack key={file.path ?? index} gap="2xs">
            <Stack direction="row" gap="xs" align="baseline">
              {!asidePath && file.path && <FilePath filePath={file.path} />}
              {file.type && (
                <Text
                  as="span"
                  variant="caption"
                  className="text-muted-foreground/60"
                >
                  {file.type}
                </Text>
              )}
            </Stack>
            {file.content ? (
              <Scroll className="max-h-64">
                <Text
                  as="pre"
                  variant="caption"
                  className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
                >
                  {file.content}
                </Text>
              </Scroll>
            ) : (
              <Text
                as="p"
                variant="caption"
                className="text-muted-foreground/60 italic"
              >
                Empty file.
              </Text>
            )}
          </Stack>
        ))}
        {removed.length > 0 && (
          // Plain text, not `FilePath`: these paths are gone, so offering to
          // open them would promise a file that is not there.
          <Stack gap="2xs" className="font-mono">
            {removed.map((path) => (
              <Text
                as="p"
                variant="caption"
                key={path}
                className="text-muted-foreground line-through"
              >
                <span className="text-destructive no-underline">−</span> {path}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </CollapsibleCard>
  );
}
