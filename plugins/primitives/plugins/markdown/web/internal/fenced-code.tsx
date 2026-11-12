import { useState } from "react";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { useCodePreviewRenderer } from "@plugins/primitives/plugins/syntax-highlight/plugins/code-preview/web";
import { ViewSwitcher } from "@plugins/primitives/plugins/view-switcher/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const VIEWS = [
  { id: "preview", title: "Preview", icon: symbol("visibility") },
  { id: "code", title: "Code", icon: symbol("code") },
] as const;

const wrapIcon = symbol("wrap-text");

/** Toggles soft-wrapping of a code block's long lines (off: they scroll sideways). */
function WrapToggle({
  wrap,
  onToggle,
  className,
}: {
  wrap: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <IconButton
      icon={wrapIcon}
      active={wrap}
      aria-pressed={wrap}
      label={wrap ? "Unwrap lines" : "Wrap lines"}
      onClick={onToggle}
      className={className}
    />
  );
}

/**
 * A fenced code block. A language with a registered code preview (a mermaid
 * fence) is drawn as what it describes, with a Preview / Code switch and a copy
 * button; every other fence is highlighted code with a wrap toggle and a copy
 * button revealed on hover (or keyboard focus) in its top-right corner.
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
  const [wrap, setWrap] = useState(false);
  const toggleWrap = () => setWrap((w) => !w);
  if (!renderer)
    return (
      // clear-both: a clipped box cannot wrap around a float.
      <Clip
        className={cn(
          hoverRevealGroup,
          "my-flow-block clear-both relative rounded-md",
        )}
      >
        <HighlightedCode code={code} lang={lang} wrap={wrap} />
        <Pin to="top-right" offset="xs" className={hoverRevealTarget}>
          <ControlSizeProvider size="xs">
            <Stack direction="row" gap="2xs">
              <WrapToggle
                wrap={wrap}
                onToggle={toggleWrap}
                className="bg-background/80 backdrop-blur"
              />
              <CopyButton
                text={code}
                tooltip="Copy code"
                className="bg-background/80 backdrop-blur"
              />
            </Stack>
          </ControlSizeProvider>
        </Pin>
      </Clip>
    );

  const Preview = renderer.Component;
  return (
    // clear-both: a clipped box cannot wrap around a float.
    <Clip className="my-flow-block clear-both rounded-md bg-muted">
      <Stack direction="row" align="center" gap="xs" className="px-sm pt-xs">
        <Text variant="caption" tone="muted" className={growClass()}>
          {renderer.label}
        </Text>
        <ControlSizeProvider size="xs">
          <ViewSwitcher options={VIEWS} activeId={view} onSelect={setView} />
          {view === "code" && <WrapToggle wrap={wrap} onToggle={toggleWrap} />}
          <CopyButton text={code} tooltip="Copy source" />
        </ControlSizeProvider>
      </Stack>
      {view === "preview" ? (
        <Preview source={code} />
      ) : (
        <HighlightedCode code={code} lang={lang} wrap={wrap} />
      )}
    </Clip>
  );
}
