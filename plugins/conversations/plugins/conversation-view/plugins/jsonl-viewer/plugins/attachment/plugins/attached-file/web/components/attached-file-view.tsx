import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { CodeListing } from "@plugins/primitives/plugins/syntax-highlight/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { ViewerThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import type { TranscriptImage } from "@plugins/conversations/plugins/transcript-source/core";
import { transcriptImageUrl } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";

interface ImageContent {
  type: "image";
  file: {
    /**
     * The image by reference: the transcript reader put its key where the
     * line's base64 was, and the page loads the bytes by URL.
     */
    image: TranscriptImage;
    /** MIME type — `image/png` for every sample seen so far. */
    type: string;
    /** Byte size of the file the user attached, before base64 expansion. */
    originalSize?: number;
    dimensions?: {
      originalWidth?: number;
      originalHeight?: number;
      displayWidth?: number;
      displayHeight?: number;
    };
  };
}

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

interface AttachedFilePayload {
  type: "file";
  filename?: string;
  displayPath?: string;
  content?: ImageContent | TextContent;
}

/** The two content kinds are a closed union on `content.type`. A third kind is a
 *  harness change we have not read yet, so it throws onto its own row rather
 *  than rendering a card with an empty body. */
function readContent(attachment: unknown): ImageContent | TextContent {
  const payload = attachment as AttachedFilePayload;
  const content = payload.content;
  if (!content) throw new Error("file attachment carries no `content`");
  const kind: string = content.type;
  if (kind === "image" || kind === "text") return content;
  throw new Error(`file attachment carries an unhandled content type: ${kind}`);
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
 * screenshot, otherwise a text file.
 *
 * The collapsed line answers "is this worth opening": for an image, how big the
 * picture is (`862×154 · 19 KB`); for text, which file and how much of it. The
 * image case opens by default because a pasted image is visible inline
 * everywhere else in this transcript (`user-image`), and a picture hidden
 * behind a chevron is a picture the reader never sees. The path is deliberately
 * absent from the image row: an attached image lives at
 * `~/.singularity/state/attachments/<uuid>.png`, a name that identifies nothing
 * the reader can use — the image itself is the identity.
 */
export function AttachedFileView({ event }: AttachmentRendererProps) {
  const payload = event.attachment as AttachedFilePayload;
  const content = readContent(event.attachment);

  if (content.type === "image") {
    const { image, originalSize, dimensions } = content.file;
    const width = dimensions?.originalWidth;
    const height = dimensions?.originalHeight;
    const path = payload.filename ?? payload.displayPath;
    return (
      <CollapsibleCard
        label="Attached image"
        note={noteOf([
          width && height ? `${width}×${height}` : null,
          originalSize ? formatSize(originalSize) : null,
        ])}
        defaultOpen
      >
        <ViewerThumbnail
          image={{
            src: transcriptImageUrl(image.key),
            // The `<uuid>.png` blob name: meaningless on the row, but it is
            // the file a download saves as.
            name: path
              ? path.slice(path.lastIndexOf("/") + 1)
              : "attached-image",
            sourceLabel: "Attached",
            alt: "Attached image",
          }}
        />
      </CollapsibleCard>
    );
  }

  const {
    content: text,
    filePath,
    numLines,
    startLine,
    totalLines,
  } = content.file;
  const shown = numLines ?? text.split("\n").length;
  const total = totalLines ?? shown;
  const path = payload.filename ?? filePath;
  return (
    <CollapsibleCard
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
