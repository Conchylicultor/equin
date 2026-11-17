import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { WallpaperCandidate } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import { z } from "zod";

const urlDraft = defineKept({
  owner: "desktop.wallpaper.from-url",
  label: "Wallpaper URL drafts",
  tier: "work",
  stamp: "nl1v68s27p",
  cap: "8 KB",
  schema: z.string(),
});

/** Cheap client-side guard — the server does the real SSRF/content validation. */
function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * From-URL provider Panel: paste an image URL. Emits a `remote` candidate the
 * picker imports via the server `import-url` endpoint, which parses/validates the
 * URL (SSRF-guarded) and mirrors the bytes locally. The client only does a basic
 * non-empty / http(s)-shaped guard.
 */
export function UrlPanel({
  onPick,
}: {
  onPick: (candidate: WallpaperCandidate) => void;
}) {
  const urlKept = useKept(urlDraft, "", { subject: "wallpaper" });
  const [url, , clearUrl] = urlKept;
  const valid = looksLikeHttpUrl(url);

  function submit() {
    if (!valid) return;
    onPick({ kind: "remote", url: url.trim() });
    clearUrl();
  }

  return (
    <Stack gap="sm">
      <Input
        keep={urlKept}
        type="url"
        inputMode="url"
        autoFocus
        placeholder="https://example.com/image.jpg"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Button type="button" disabled={!valid} onClick={submit}>
        Set wallpaper
      </Button>
      <Text variant="caption" tone="muted">
        Paste a direct link to an image. It's validated and saved on the server.
      </Text>
    </Stack>
  );
}
