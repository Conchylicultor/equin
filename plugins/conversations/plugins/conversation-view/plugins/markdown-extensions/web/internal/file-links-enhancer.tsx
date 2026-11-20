import { useMemo, type ReactNode } from "react";
import {
  linkifyChildren,
  parseFileLinks,
} from "@plugins/primitives/plugins/file-links/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  MarkdownEnhancementContext,
  MarkdownLink,
  useMarkdownEnhancement,
  type MarkdownEnhancement,
} from "@plugins/primitives/plugins/markdown/web";
import { useFileTarget } from "./use-file-target";
import { WebLink, isWebUrl } from "./web-link";

export function FileLinksEnhancer({ children }: { children: ReactNode }) {
  const fileTarget = useFileTarget();

  const enhancement = useMemo(
    (): MarkdownEnhancement => ({
      transform: fileTarget
        ? (c: ReactNode) => linkifyChildren(c, fileTarget)
        : undefined,
      components: {
        a: ({ href, children: kids, ...p }) => {
          // A web page opens beside the conversation (WebLink), whether or
          // not this transcript can resolve file paths.
          if (href !== undefined && isWebUrl(href)) {
            return (
              <WebLink href={href} {...p}>
                {kids}
              </WebLink>
            );
          }
          if (fileTarget && href && !href.startsWith("#")) {
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
            <MarkdownLink href={href} {...p}>
              {kids}
            </MarkdownLink>
          );
        },
      },
    }),
    [fileTarget],
  );

  const value = useMarkdownEnhancement(enhancement);
  return (
    <MarkdownEnhancementContext.Provider value={value}>
      {children}
    </MarkdownEnhancementContext.Provider>
  );
}
