# Extract `useCopyToClipboard` + `CopyButton` primitive

## Context

The `useState(false) → clipboard.writeText → setTimeout(reset) → icon-swap` pattern is copy-pasted in 4 files. It is a pure primitive with no domain coupling — a textbook candidate for `plugins/primitives/`. Extracting it gives a single place to adjust defaults and removes ~15 lines of boilerplate from each call site.

| File | Text source | Delay | Wrapper change |
|---|---|---|---|
| `jsonl-viewer/web/components/copy-button.tsx` | prop `text` | 1500 ms | keep `RowActionButton` (public export) |
| `code/review/web/components/review-file-row.tsx` | `file.path` | 1500 ms | keep raw `<button>` + `e.stopPropagation()` |
| `auth/google/setup-wizard/web/components/google-setup-pane.tsx` | constant | **2000 ms** | keep `<Button size="sm">` (different size) |
| `primitives/filepath-breadcrumb/web/internal/filepath-breadcrumb.tsx` | prop `path` | 1500 ms | replace with `<CopyButton>` |

---

## New plugin: `plugins/primitives/plugins/copy-to-clipboard/`

### `package.json`
```json
{
  "name": "@singularity/plugin-primitives-copy-to-clipboard",
  "private": true,
  "version": "0.0.1"
}
```

### `web/internal/use-copy-to-clipboard.ts`
```ts
import { useState, useCallback } from "react";

export function useCopyToClipboard(
  text: string,
  delay = 1500,
): { copy: () => void; copied: boolean } {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), delay);
    });
  }, [text, delay]);
  return { copy, copied };
}
```

### `web/internal/copy-button.tsx`
```tsx
import { MdCheck, MdContentCopy } from "react-icons/md";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "./use-copy-to-clipboard";

export interface CopyButtonProps {
  text: string;
  title?: string;
  className?: string;
  iconClassName?: string;
}

export function CopyButton({ text, title, className, iconClassName = "size-3" }: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard(text);
  return (
    <Button variant="ghost" size="icon" className={className} title={title} aria-label={title} onClick={copy}>
      {copied ? <MdCheck className={iconClassName} /> : <MdContentCopy className={iconClassName} />}
    </Button>
  );
}
```

### `web/index.ts`
```ts
import type { PluginDefinition } from "@core";

export { useCopyToClipboard } from "./internal/use-copy-to-clipboard";
export { CopyButton, type CopyButtonProps } from "./internal/copy-button";

export default {
  id: "copy-to-clipboard",
  name: "Copy to Clipboard",
  description:
    "useCopyToClipboard hook and CopyButton component for the clipboard write + timeout-reset pattern.",
  contributions: [],
} satisfies PluginDefinition;
```

---

## Migrations

### 1. `jsonl-viewer/web/components/copy-button.tsx`

Replace local state+handler with hook. Keep `CopyTextAction` name and `RowActionButton` wrapper (public API).

```tsx
import { MdCheck, MdContentCopy } from "react-icons/md";
import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { RowActionButton } from "./row-action-button";

export function CopyTextAction({ text, title = "Copy" }: { text: string; title?: string }) {
  const { copy, copied } = useCopyToClipboard(text);
  return (
    <RowActionButton title={title} onClick={copy}>
      {copied ? <MdCheck className="size-3" /> : <MdContentCopy className="size-3" />}
    </RowActionButton>
  );
}
```

`jsonl-viewer/web/index.ts` unchanged — `CopyTextAction` stays exported.

### 2. `code/review/web/components/review-file-row.tsx`

Remove `useState(false)` + `copyPath` callback. Use hook; `e.stopPropagation()` moves inline to the onClick handler (the button is nested inside the row's own `<button onClick={onToggle}>`).

```diff
+import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
 ...
-  const [copied, setCopied] = useState(false);
-  const copyPath = useCallback((e: React.MouseEvent) => {
-    e.stopPropagation();
-    void navigator.clipboard.writeText(file.path).then(() => {
-      setCopied(true);
-      setTimeout(() => setCopied(false), 1500);
-    });
-  }, [file.path]);
+  const { copy, copied } = useCopyToClipboard(file.path);
   ...
-      onClick={copyPath}
+      onClick={(e) => { e.stopPropagation(); copy(); }}
```

Remove `useState` / `useCallback` imports if no longer used elsewhere in the file.

### 3. `auth/google/setup-wizard/web/components/google-setup-pane.tsx`

Remove `useState` for `copied` + `handleCopyRedirectUri`. Pass `delay=2000`.

```diff
+import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
 ...
-  const [copied, setCopied] = useState(false);
+  const { copy: copyRedirectUri, copied } = useCopyToClipboard(REDIRECT_URI, 2000);
   ...
-  async function handleCopyRedirectUri() {
-    await navigator.clipboard.writeText(REDIRECT_URI);
-    setCopied(true);
-    setTimeout(() => setCopied(false), 2000);
-  }
   ...
-          onClick={handleCopyRedirectUri}
+          onClick={copyRedirectUri}
```

Keep `<Button variant="ghost" size="sm">` wrapper (`size="sm"` differs from the default `size="icon"` in `CopyButton`). `useState` import stays — other state fields use it.

### 4. `primitives/filepath-breadcrumb/web/internal/filepath-breadcrumb.tsx`

Cleanest migration: replace state + handler + inline Button with `<CopyButton>`. `aria-label` is handled automatically inside `CopyButton` via `title`.

```diff
-import { useCallback, useState } from "react";
-import { MdContentCopy, MdCheck } from "react-icons/md";
-import { Button } from "@/components/ui/button";
+import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
 ...
   const copyAction = showCopy ? (
-    <Button
-      variant="ghost"
-      size="icon"
-      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
-      title="Copy path"
-      aria-label="Copy path"
-      onClick={copyPath}
-    >
-      {copied ? <MdCheck className="size-3" /> : <MdContentCopy className="size-3" />}
-    </Button>
+    <CopyButton
+      text={path}
+      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
+      title="Copy path"
+    />
   ) : undefined;
```

---

## Verification

1. **Build**: `./equin build` — should complete with no TypeScript errors.
2. **Browser smoke tests**:
   - JSONL viewer: hover a row → copy icon → check icon appears ~1.5 s
   - Review pane: hover a file row → copy path → check icon appears, row doesn't toggle (confirms `stopPropagation`)
   - Google setup wizard → copy redirect URI → check for ~2 s
   - File breadcrumb → copy icon → check ~1.5 s, clipboard has the full path
3. **Regression**: `CopyTextAction` still importable from `@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web`.
