import { useRef } from "react";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { z } from "zod";
import {
  cn,
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import {
  useBlockActivate,
  type BlockRendererProps,
} from "@plugins/page/plugins/editor/web";
import { embedBlock, toEmbedUrl } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { NewTabLink } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { ForeignFrame } from "@plugins/primitives/plugins/embed/plugins/frame/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

const smartDisplayIcon = symbol("smart-display");

const embedUrlDraft = defineKept({
  owner: "embed.url",
  label: "Embed links",
  tier: "work",
  stamp: "nl1v68s27p",
  cap: "8 KB",
  schema: z.string(),
});

export function EmbedBlock({ block, editor }: BlockRendererProps) {
  const { url } = embedBlock.parse(block.data);

  if (!url) {
    return (
      <EmptyEmbedBlock
        blockId={block.id}
        onSubmit={(u) => editor.update({ url: u })}
      />
    );
  }

  return <FilledEmbedBlock url={url} onReplace={() => editor.update({})} />;
}

function EmptyEmbedBlock({
  blockId,
  onSubmit,
}: {
  blockId: string;
  onSubmit: (url: string) => void;
}) {
  const link = useKept(embedUrlDraft, "", { subject: blockId });
  const [value, , clearLink] = link;
  const inputRef = useRef<HTMLInputElement>(null);

  // An empty embed block is a PROMPT — it is asking for a URL — so Enter on the
  // block's caret host puts the caret in the URL field. Focus reported by the
  // field itself bubbles to the host (React `onFocus` is `focusin`), so there is
  // nothing to hand-report back to the editor.
  useBlockActivate(() => focusElement(inputRef.current, { reveal: false }));

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    clearLink();
  }

  return (
    <div className="px-md py-xs">
      <Stack
        gap="sm"
        className="rounded-md border border-dashed border-border px-md py-lg"
      >
        <Stack
          direction="row"
          gap="xs"
          align="center"
          className="text-muted-foreground"
        >
          <Icon icon={smartDisplayIcon} className="size-4" />
          <Text variant="caption" tone="muted">
            Paste a link to embed (YouTube, Vimeo, Spotify, …)
          </Text>
        </Stack>
        <Stack direction="row" gap="sm" align="center">
          <Input
            // Chrome, not document content: this field holds nothing the page
            // persists, so its ⌘Z belongs to the browser's own input history.
            // Without the marker the block list's `surfaceUndoProps` ancestor
            // claims the key and rewinds an unrelated block edit mid-typing.
            {...localUndoProps}
            ref={inputRef}
            keep={link}
            placeholder="https://…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button type="button" disabled={!value.trim()} onClick={submit}>
            Embed
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}

function FilledEmbedBlock({
  url,
  onReplace,
}: {
  url: string;
  onReplace: () => void;
}) {
  return (
    <div className="px-md py-xs">
      <Stack gap="xs" className={hoverRevealGroup}>
        <Stack direction="row" gap="sm" align="center" justify="end">
          <NewTabLink
            href={url}
            className="text-caption text-muted-foreground hover:text-foreground hover:underline"
          >
            Open original
          </NewTabLink>
          {/*
           * Escape hatch: many sites send X-Frame-Options / CSP frame-ancestors
           * and refuse to render in an iframe. That refusal happens inside the
           * browser and is NOT reliably detectable from our JS (no error event,
           * no readable cross-origin state), so we always expose "Open original"
           * plus a way to swap the URL out.
           */}
          <button
            type="button"
            onClick={onReplace}
            className={cn(
              hoverRevealTarget,
              "text-caption text-muted-foreground hover:text-foreground hover:underline",
            )}
          >
            Replace URL
          </button>
        </Stack>
        <Overlay fill className="w-full aspect-video">
          {/* Another site's page, on its own origin. An equin page, this
              computer or a non-web address is refused, not framed: inside a
              frame it would run with the owner's authority. */}
          <ForeignFrame
            url={toEmbedUrl(url)}
            className="h-full w-full rounded-md border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            title="Embedded content"
            refused={(reason) => (
              <Stack
                align="center"
                justify="center"
                gap="xs"
                className="h-full w-full rounded-md border border-border p-md"
              >
                <Text variant="caption" tone="muted">
                  {reason}
                </Text>
              </Stack>
            )}
          />
        </Overlay>
      </Stack>
    </div>
  );
}
