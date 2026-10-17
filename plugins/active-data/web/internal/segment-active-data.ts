import { useMemo } from "react";
import type { ComponentType } from "react";
import {
  UNSAFE_unsealSlotComponent,
  type SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { ActiveData } from "../slots";
import type { ActiveDataBlockContribution } from "../slots";
import { parseAttrs } from "./tag-attrs";
import { isBlockForm } from "../../core";

type SealedBlockContribution = SealContributions<ActiveDataBlockContribution>;

export type ActiveDataSegment =
  | { type: "markdown"; text: string }
  | {
      type: "block";
      tag: string;
      component: ComponentType<{
        content: string;
        attrs: Record<string, string>;
      }>;
      content: string;
      attrs: Record<string, string>;
    };

/**
 * `text` with every code span and fenced code block blanked out (same length,
 * line breaks kept), so a tag written AS CODE — `` `</go>` `` in a sentence
 * about the tag — is not read as one. Markdown would render it as code, so the
 * segmenter must not pair it either; indices into the result are indices into
 * `text`.
 */
export function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(
      /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm,
      blank,
    )
    .replace(/(`+)[^`\n][^\n]*?\1/g, blank);
}

export function buildSegments(
  rawText: string,
  blockContribs: SealedBlockContribution[],
): ActiveDataSegment[] {
  if (blockContribs.length === 0) {
    return rawText ? [{ type: "markdown", text: rawText }] : [];
  }

  const escaped = blockContribs
    .map((c) => c.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`<(${escaped})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`, "g");

  const segments: ActiveDataSegment[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  const masked = maskCode(rawText);

  while ((m = re.exec(masked)) !== null) {
    // Matched on the masked text; the body is read back from the raw one (it
    // ends right before the `</tag>`).
    const end = m.index + m[0].length;
    const inner = rawText.slice(
      end - m[1]!.length - 3 - m[3]!.length,
      end - m[1]!.length - 3,
    );
    const contrib = blockContribs.find((c) => c.tag === m![1])!;
    // An inline-capable tag is a block exactly when its body is in block form
    // — the one shape rule the draft and the sent message read too. Where it
    // sits does not matter: `Pick one: <go>` ending a line of prose is a block,
    // the prose before it its own markdown; `<tag>one line</tag>` stays in the
    // markdown and renders through `inline`.
    if (contrib.inline && !isBlockForm(inner)) {
      continue;
    }
    if (m.index > cursor) {
      const text = rawText.slice(cursor, m.index);
      if (text.trim()) segments.push({ type: "markdown", text });
    }

    const tag = m[1]!;
    const attrStr = (m[2] ?? "").trim();
    const content = inner.trim();
    const attrs = attrStr ? parseAttrs(attrStr) : {};

    segments.push({
      type: "block",
      tag,
      // UNSAFE: spliced into foreign markdown ReactNode tree.
      component: UNSAFE_unsealSlotComponent(contrib.component),
      content,
      attrs,
    });
    cursor = end;
  }

  if (cursor < rawText.length) {
    const text = rawText.slice(cursor);
    if (text.trim()) segments.push({ type: "markdown", text });
  }

  return segments;
}

export function useActiveDataSegments(rawText: string): ActiveDataSegment[] {
  const contributions = ActiveData.Tag.useContributions();
  const blockContribs = useMemo(
    () =>
      contributions.filter(
        (c): c is SealedBlockContribution => c.display === "block",
      ),
    [contributions],
  );
  return useMemo(
    () => buildSegments(rawText, blockContribs),
    [rawText, blockContribs],
  );
}
