import { useMemo, type ReactNode } from "react";
import {
  linkifyChildren,
  parseFileLinks,
} from "@plugins/primitives/plugins/file-links/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  MarkdownEnhancementContext,
  useMarkdownEnhancement,
  type MarkdownEnhancement,
} from "@plugins/primitives/plugins/markdown/web";
import { useFileTarget } from "./use-file-target";

export function FileLinksEnhancer({ children }: { children: ReactNode }) {
  const fileTarget = useFileTarget();

  const enhancement = useMemo((): MarkdownEnhancement | null => {
    if (!fileTarget) return null;
    return {
      transform: (c: ReactNode) => linkifyChildren(c, fileTarget),
      components: {
        a: ({ href, children: kids, ...p }) => {
          if (href && !href.startsWith("http") && !href.startsWith("#")) {
            const segments = parseFileLinks(href);
            if (segments.length === 1 && segments[0]?.type === "path") {
              return (
                <button
                  type="button"
                  {...activationProps(fileTarget(href), { isolate: true })}
                  className="text-primary-text underline"
                >
                  {kids}
                </button>
              );
            }
          }
          return (
            <a
              className="text-primary-text underline"
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
              {...p}
            >
              {kids}
            </a>
          );
        },
      },
    };
  }, [fileTarget]);

  const value = useMarkdownEnhancement(enhancement);
  return (
    <MarkdownEnhancementContext.Provider value={value}>
      {children}
    </MarkdownEnhancementContext.Provider>
  );
}
