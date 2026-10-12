import { useCallback, useMemo, type ReactNode } from "react";
import { parseFileLinks } from "@plugins/primitives/plugins/file-links/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import {
  MarkdownEnhancementContext,
  useMarkdownEnhancement,
  type MarkdownEnhancement,
} from "@plugins/primitives/plugins/markdown/web";
import { useFileTarget } from "./use-file-target";

export function CodeEnhancer({ children }: { children: ReactNode }) {
  const fileTarget = useFileTarget();

  const inlineCode = useCallback(
    (text: string): ReactNode | null => {
      if (!fileTarget) return null;
      if (text.startsWith("http://") || text.startsWith("https://")) {
        return (
          <a
            className="text-caption text-primary-text rounded-sm bg-muted px-xs py-2xs font-mono underline hover:opacity-80"
            href={text}
            target="_blank"
            rel="noopener noreferrer"
          >
            {text}
          </a>
        );
      }
      const segments = parseFileLinks(text);
      if (segments.length === 1 && segments[0]?.type === "path") {
        const seg = segments[0]!;
        return (
          <LinkChip
            mono
            activation={fileTarget(seg.value, seg.line)}
            className="text-info"
          >
            {seg.line != null ? `${seg.value}:${seg.line}` : seg.value}
          </LinkChip>
        );
      }
      return null;
    },
    [fileTarget],
  );

  const enhancement = useMemo((): MarkdownEnhancement | null => {
    if (!fileTarget) return null;
    return { inlineCode };
  }, [fileTarget, inlineCode]);

  const value = useMarkdownEnhancement(enhancement);
  return (
    <MarkdownEnhancementContext.Provider value={value}>
      {children}
    </MarkdownEnhancementContext.Provider>
  );
}
