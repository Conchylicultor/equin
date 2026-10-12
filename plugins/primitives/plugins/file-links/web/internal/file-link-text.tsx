import { Fragment, type ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { parseFileLinks } from "./parse";

export interface FileLinkTextProps {
  text: string;
  /**
   * What activating a path chip does — a `LinkTarget` for anything that
   * navigates, so ⌘/middle-click opens the file in a new browser tab. Omitted,
   * paths render as inert badges.
   */
  fileTarget?: (path: string, line?: number) => Activation;
}

export function FileLinkText({
  text,
  fileTarget,
}: FileLinkTextProps): ReactNode {
  if (!text) return null;
  const segments = parseFileLinks(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "url") {
          return (
            <a
              key={i}
              href={seg.value}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-text underline"
              onClick={(e) => e.stopPropagation()}
            >
              {seg.value}
            </a>
          );
        }
        if (seg.type !== "path")
          return <Fragment key={i}>{seg.value}</Fragment>;
        if (fileTarget) {
          return (
            <LinkChip
              key={i}
              mono
              activation={fileTarget(seg.value, seg.line)}
              className="text-info"
            >
              {seg.line != null ? `${seg.value}:${seg.line}` : seg.value}
            </LinkChip>
          );
        }
        return (
          <Badge key={i} variant="muted" className="font-mono">
            {seg.value}
          </Badge>
        );
      })}
    </>
  );
}
