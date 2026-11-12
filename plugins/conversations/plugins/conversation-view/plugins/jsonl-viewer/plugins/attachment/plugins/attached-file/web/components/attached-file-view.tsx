import type { FileReadOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
  CollapsibleCard,
  TimelineLine,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { CodeListing } from "@plugins/primitives/plugins/syntax-highlight/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import type {
  AttachmentEvent,
  AttachmentRendererProps,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import type { AttachmentRole } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web";
import { isAttachmentDiskPath } from "@plugins/conversations/core";
import { AssetThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import type { TranscriptImage } from "@plugins/conversations/plugins/transcript-source/core";
import { transcriptImage } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const imageIcon = symbol("image");
const descriptionIcon = symbol("description");
const pdfIcon = symbol("article");
const notebookIcon = symbol("book");

/**
 * Every content kind a `file` attachment can carry: Claude Code feeds the model
 * an attached file through its Read tool, so `content` IS the Read tool's
 * output, and the SDK publishes that union (`FileReadOutput`). The agent runs
 * the SDK's own bundled CLI (`infra/claude-cli/sdk`), so the CLI that writes
 * the transcript and the union read here come from one package version: an SDK
 * bump that adds a kind adds an arm here, and `AttachedFileView`'s exhaustive
 * switch stops compiling until it draws it.
 */
type SdkContent<K extends FileReadOutput["type"]> = Extract<
  FileReadOutput,
  { type: K }
>;

interface ImageContent {
  type: "image";
  file: Omit<
    SdkContent<"image">["file"],
    "base64" | "type" | "originalSize"
  > & {
    /**
     * The image by reference: the transcript reader put its key where the
     * line's base64 was, and the page loads the bytes by URL.
     */
    image: TranscriptImage;
    /** MIME type — `image/png` for every sample seen so far. */
    type: string;
    /** Byte size of the file the user attached, before base64 expansion. */
    originalSize?: number;
  };
}

/** Older transcripts omit the line counts, so they stay optional here. */
interface TextContent {
  type: "text";
  file: {
    /** RAW file text — NOT the `cat -n` form the Read tool and the edited-file
     *  attachment carry. */
    content: string;
    filePath?: string;
    /** Lines actually included, which can be a window over `totalLines`. */
    numLines?: number;
    startLine?: number;
    totalLines?: number;
  };
}

/** The SDK's kinds, with the two this transcript reshapes (image: base64 →
 *  reference; text: counts optional) replaced by their transcript form. */
type AttachedContent =
  | ImageContent
  | TextContent
  | Exclude<FileReadOutput, { type: "image" | "text" }>;

interface AttachedFilePayload {
  type: "file";
  filename?: string;
  displayPath?: string;
  content?: AttachedContent;
}

/**
 * A file sent from equin's composer reaches the agent as `@<attachment disk
 * path>`, and the user's message already draws that ref as the file itself (a
 * thumbnail or chip). Its attachment event is then only the harness's record of
 * what it fed the model — context, folded after the prompt — not a second copy
 * of the picture. A file the prompt only names (`@src/foo.ts`) keeps its row:
 * the content is shown nowhere else.
 */
export function attachedFileRole(event: AttachmentEvent): AttachmentRole {
  const path = (event.attachment as AttachedFilePayload).filename;
  return path !== undefined && isAttachmentDiskPath(path)
    ? "context"
    : "conversation";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** The card's `note` reads as a middot-led suffix, so build it from the parts
 *  that survived. */
function noteOf(parts: (string | null)[]): string | undefined {
  const kept = parts.filter((p): p is string => p !== null);
  return kept.length > 0 ? `· ${kept.join(" · ")}` : undefined;
}

/**
 * A file the user attached to their message — 9 times in 10 a pasted
 * screenshot, otherwise a text file; now and then a PDF (whole, or as page
 * images) or a notebook, whose bytes the transcript does not keep, so they
 * are one static line: what it was, how big, and where it lives.
 *
 * The collapsed line answers "is this worth opening": for an image, how big the
 * picture is (`862×154 · 19 KB`); for text, which file and how much of it. The
 * image case opens by default because a pasted image is visible inline
 * everywhere else in this transcript (`user-image`), and a picture hidden
 * behind a chevron is a picture the reader never sees. The path is deliberately
 * absent from the image row: an attached image lives at
 * `~/.equin/state/attachments/<uuid>.png`, a name that identifies nothing
 * the reader can use — the image itself is the identity.
 */
export function AttachedFileView({ event }: AttachmentRendererProps) {
  const payload = event.attachment as AttachedFilePayload;
  const content = payload.content;
  if (!content) throw new Error("file attachment carries no `content`");
  const path = payload.filename ?? payload.displayPath;
  switch (content.type) {
    case "image":
      return <ImageCard content={content} path={path} />;
    case "text":
      return <TextCard content={content} path={payload.filename} />;
    case "pdf":
      // The CLI persists `base64` empty: the bytes went to the model and stay
      // in the file at `filePath`, so the row names the file and its size.
      return (
        <TimelineLine
          icon={<Icon icon={pdfIcon} className="size-3.5" />}
          label="Attached PDF"
        >
          {formatSize(content.file.originalSize)}
          <FilePath filePath={content.file.filePath} />
        </TimelineLine>
      );
    case "parts":
      // A PDF the CLI fed the model as page images; the pages are not kept.
      return (
        <TimelineLine
          icon={<Icon icon={pdfIcon} className="size-3.5" />}
          label="Attached PDF"
        >
          {`${content.file.count} ${content.file.count === 1 ? "page" : "pages"} · ${formatSize(content.file.originalSize)}`}
          <FilePath filePath={content.file.filePath} />
        </TimelineLine>
      );
    case "notebook": {
      const cells = content.file.cells.length;
      return (
        <TimelineLine
          icon={<Icon icon={notebookIcon} className="size-3.5" />}
          label="Attached notebook"
        >
          {`${cells} ${cells === 1 ? "cell" : "cells"}`}
          <FilePath filePath={content.file.filePath} />
        </TimelineLine>
      );
    }
    default:
      // Unreachable while the switch covers `AttachedContent`: tsc rejects a
      // kind an SDK bump adds until it has its case.
      return unhandledKind(content);
  }
}

function unhandledKind(content: never): never {
  throw new Error(
    `file attachment carries an unhandled content type: ${(content as { type: string }).type}`,
  );
}

function ImageCard({
  content,
  path,
}: {
  content: ImageContent;
  path: string | undefined;
}) {
  const { image, originalSize, dimensions } = content.file;
  const width = dimensions?.originalWidth;
  const height = dimensions?.originalHeight;
  return (
    <CollapsibleCard
      icon={<Icon icon={imageIcon} className="size-3.5" />}
      label="Attached image"
      note={noteOf([
        width && height ? `${width}×${height}` : null,
        originalSize ? formatSize(originalSize) : null,
      ])}
      defaultOpen
    >
      <AssetThumbnail
        asset={transcriptImage(image.key)}
        image={{
          // The `<uuid>.png` blob name: meaningless on the row, but it is
          // the file a download saves as.
          name: path ? path.slice(path.lastIndexOf("/") + 1) : "attached-image",
          sourceLabel: "Attached",
          alt: "Attached image",
          // Known before the bytes load, so the card is its final height
          // from its first frame.
          width: width ?? image.width,
          height: height ?? image.height,
        }}
      />
    </CollapsibleCard>
  );
}

function TextCard({
  content,
  path: filename,
}: {
  content: TextContent;
  path: string | undefined;
}) {
  const {
    content: text,
    filePath,
    numLines,
    startLine,
    totalLines,
  } = content.file;
  const shown = numLines ?? text.split("\n").length;
  const total = totalLines ?? shown;
  const path = filename ?? filePath;
  return (
    <CollapsibleCard
      icon={<Icon icon={descriptionIcon} className="size-3.5" />}
      label="Attached file"
      note={noteOf([
        shown < total
          ? `${shown} of ${total} lines`
          : `${shown} ${shown === 1 ? "line" : "lines"}`,
      ])}
      aside={path ? <FilePath filePath={path} /> : undefined}
    >
      <CodeListing
        code={text}
        startLine={startLine ?? 1}
        path={path ?? ""}
        emptyText="(empty result)"
      />
    </CollapsibleCard>
  );
}
