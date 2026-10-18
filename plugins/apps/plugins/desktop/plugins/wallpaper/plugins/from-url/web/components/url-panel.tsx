import { useState } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button, Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { WallpaperCandidate } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";

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
  const [url, setUrl] = useState("");
  const valid = looksLikeHttpUrl(url);

  function submit() {
    if (!valid) return;
    onPick({ kind: "remote", url: url.trim() });
  }

  return (
    <Stack gap="sm">
      <Input
        type="url"
        inputMode="url"
        value={url}
        autoFocus
        placeholder="https://example.com/image.jpg"
        onChange={(e) => setUrl(e.target.value)}
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
