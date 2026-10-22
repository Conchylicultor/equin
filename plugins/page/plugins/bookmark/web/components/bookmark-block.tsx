import { useEffect, useRef, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { attachmentUrl } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Button,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { useImageLoad } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  useBlockActivate,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import { bookmarkBlock, linkPreview, type LinkPreview } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const bookmarkIcon = symbol("bookmark");
const refreshIcon = symbol("refresh");

/**
 * Three states keyed on `(url, fetched)`:
 *  1. `!url` → URL-input empty state. Submit just sets the url (no fetch here).
 *  2. `url && !fetched` → loading card; reads the link preview for the url,
 *     then writes the metadata + `fetched: true`. This is the single fetch
 *     path shared by manual entry and `convertTo(BOOKMARK_TYPE, { url })` from
 *     paste-to-bookmark.
 *  3. `url && fetched` → the final preview card.
 */
export function BookmarkBlock({ block, editor }: BlockRendererProps) {
  const { url, title, description, siteName, imageId, faviconId, fetched } =
    bookmarkBlock.parse(block.data);

  if (!url) {
    return <EmptyBookmarkBlock editor={editor} />;
  }

  if (!fetched) {
    return <FetchingBookmarkBlock url={url} editor={editor} />;
  }

  return (
    <FilledBookmarkBlock
      url={url}
      title={title}
      description={description}
      siteName={siteName}
      imageId={imageId}
      faviconId={faviconId}
      editor={editor}
    />
  );
}

function EmptyBookmarkBlock({
  editor,
}: {
  editor: BlockRendererProps["editor"];
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // An empty bookmark block is a PROMPT — it is asking for a link — so Enter on
  // the block's caret host puts the caret in the URL field. Focus reported by
  // the field itself bubbles to the host (React `onFocus` is `focusin`), so
  // there is nothing to hand-report back to the editor.
  useBlockActivate(() => inputRef.current?.focus());

  function submit() {
    const url = value.trim();
    if (!url) return;
    // Just set the url — the fetch happens in the loading state (state 2) so
    // manual entry and paste-to-bookmark share one fetch path.
    editor.update({ url });
  }

  return (
    <Inset x="md" y="xs">
      <Stack direction="row" gap="sm" align="center">
        <Icon icon={bookmarkIcon} className="size-4 text-muted-foreground" />
        <Input
          // Chrome, not document content: this field holds nothing the page
          // persists, so its ⌘Z belongs to the browser's own input history.
          // Without the marker the block list's `surfaceUndoProps` ancestor
          // claims the key and rewinds an unrelated block edit mid-typing.
          {...localUndoProps}
          ref={inputRef}
          value={value}
          placeholder="Paste a link…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button type="button" disabled={!value.trim()} onClick={submit}>
          Add bookmark
        </Button>
      </Stack>
    </Inset>
  );
}

function FetchingBookmarkBlock({
  url,
  editor,
}: {
  url: string;
  editor: BlockRendererProps["editor"];
}) {
  const preview = useLive(linkPreview, { url });

  // Copy the answer into the block once: the write turns this block into the
  // filled card (state 3), which unmounts this read. A failure marks the block
  // fetched too — a plain link card — so it never loops.
  const copiedRef = useRef<LinkPreview | Error | null>(null);
  useEffect(() => {
    if (preview.status === "ready") {
      if (copiedRef.current === preview.data) return;
      copiedRef.current = preview.data;
      const meta = preview.data;
      editor.update({
        url,
        ...meta,
        // Mirror the cached image ids into the shared attachment convention so
        // the generic reconcile links them (otherwise the orphan sweep reclaims).
        attachmentIds: [meta.imageId, meta.faviconId].filter(
          (id): id is string => Boolean(id),
        ),
        fetched: true,
      });
    } else if (preview.status === "error") {
      if (copiedRef.current === preview.error) return;
      copiedRef.current = preview.error;
      editor.update({ url, fetched: true });
    }
  }, [preview, url, editor]);

  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    // `new URL` throws TypeError on an unparseable url — keep the raw url as the
    // displayed host. Re-throw anything unexpected.
    if (!(err instanceof TypeError)) throw err;
  }

  return (
    <Inset x="md" y="xs">
      <Stack as={Card} direction="row" align="center" gap="md" className="p-md">
        <Icon
          icon={bookmarkIcon}
          className={cn(rigidClass(), "size-4 text-muted-foreground")}
        />
        <Stack as={Fill} gap="2xs">
          <Text variant="label" className="truncate font-semibold">
            {hostname}
          </Text>
          {preview.status === "error" ? (
            <ResourceErrorInline error={preview.error} variant="inline" />
          ) : (
            <Loading variant="text" label="Fetching preview…" />
          )}
        </Stack>
      </Stack>
    </Inset>
  );
}

/**
 * The link's cached favicon or preview image. Both are decoration of a card
 * whose click opens the link, so one that no longer loads is dropped: the card
 * reads exactly as a link that never had one, never the broken-image glyph.
 */
function PreviewImage({
  attachmentId,
  className,
}: {
  attachmentId: string;
  className: string;
}) {
  const src = attachmentUrl(attachmentId);
  const { load, imgKey, imgProps } = useImageLoad(src);
  if (load.kind === "failed") return null;
  return (
    <img key={imgKey} src={src} alt="" {...imgProps} className={className} />
  );
}

function FilledBookmarkBlock({
  url,
  title,
  description,
  siteName,
  imageId,
  faviconId,
  editor,
}: {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  imageId?: string;
  faviconId?: string;
  editor: BlockRendererProps["editor"];
}) {
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    // `new URL` throws TypeError on an unparseable url — keep the raw url as the
    // displayed host. Re-throw anything unexpected.
    if (!(err instanceof TypeError)) throw err;
  }

  return (
    <Inset x="md" y="xs">
      <div className={cn(hoverRevealGroup, "relative")}>
        <Card
          as="a"
          interactive
          href={url}
          target="_blank"
          rel="noreferrer"
          className="p-none no-underline"
        >
          <Clip>
            <Stack direction="row" gap="md" align="stretch">
              <Stack as={Fill} gap="2xs" className="p-md">
                <Stack direction="row" gap="2xs" align="center">
                  {faviconId ? (
                    <PreviewImage
                      attachmentId={faviconId}
                      className="size-4 rounded-sm"
                    />
                  ) : null}
                  {siteName ? (
                    <Text variant="caption" tone="muted" className="truncate">
                      {siteName}
                    </Text>
                  ) : null}
                </Stack>
                <Text variant="label" className="line-clamp-2 font-semibold">
                  {title ?? url}
                </Text>
                {description ? (
                  <Text variant="caption" tone="muted" className="line-clamp-2">
                    {description}
                  </Text>
                ) : null}
                <Text variant="caption" tone="muted" className="truncate">
                  {hostname}
                </Text>
              </Stack>
              {imageId ? (
                <PreviewImage
                  attachmentId={imageId}
                  className="h-auto w-32 object-cover"
                />
              ) : null}
            </Stack>
          </Clip>
        </Card>
        <Pin to="top-right" offset="xs">
          <button
            type="button"
            aria-label="Replace bookmark"
            onClick={() => editor.update({})}
            className={cn(
              hoverRevealTarget,
              "size-6 rounded-full bg-black/50 text-white hover:bg-black/70",
            )}
          >
            <Center className="size-full">
              <Icon icon={refreshIcon} className="size-4" />
            </Center>
          </button>
        </Pin>
      </div>
    </Inset>
  );
}
