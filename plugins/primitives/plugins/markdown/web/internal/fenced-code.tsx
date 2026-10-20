import { useState } from "react";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { useCodePreviewRenderer } from "@plugins/primitives/plugins/syntax-highlight/plugins/code-preview/web";
import { ViewSwitcher } from "@plugins/primitives/plugins/view-switcher/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const VIEWS = [
  { id: "preview", title: "Preview", icon: symbol("visibility") },
  { id: "code", title: "Code", icon: symbol("code") },
] as const;

/**
 * A fenced code block. A language with a registered code preview (a mermaid
 * fence) is drawn as what it describes, with a Preview / Code switch and a copy
 * button; every other fence is highlighted code, as before.
 */
export function FencedCode({
  code,
  lang,
}: {
  code: string;
  lang: string | null;
}) {
  const renderer = useCodePreviewRenderer(lang);
  const [view, setView] = useState<string>("preview");
  if (!renderer) return <HighlightedCode code={code} lang={lang} />;

  const Preview = renderer.Component;
  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- my-2 sets code-block vertical rhythm against surrounding markdown, matching HighlightedCode
    <Clip className="my-2 rounded-md bg-muted">
      <Stack direction="row" align="center" gap="xs" className="px-sm pt-xs">
        <Text variant="caption" tone="muted" className={growClass()}>
          {renderer.label}
        </Text>
        <ControlSizeProvider size="xs">
          <ViewSwitcher options={VIEWS} activeId={view} onSelect={setView} />
          <CopyButton text={code} tooltip="Copy source" />
        </ControlSizeProvider>
      </Stack>
      {view === "preview" ? (
        <Preview source={code} />
      ) : (
        <HighlightedCode code={code} lang={lang} flush />
      )}
    </Clip>
  );
}
