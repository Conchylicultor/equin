import { serveCollection } from "@plugins/network/plugins/live/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { wrapPreprompt } from "@plugins/conversations/plugins/transcript-source/core";
import {
  conversationSystemPrompt,
  PREPROMPT_SECTION_ID,
  SYSTEM_PROMPT_SECTION_TAG,
  type SystemPromptSectionRecord,
} from "@plugins/conversations/plugins/system-prompt/core";
import {
  SystemPrompt,
  type SystemPromptSection,
} from "@plugins/conversations/plugins/system-prompt/server";
import { conversationSystemPromptExt } from "./tables";

// The context card's read: a primary-key seek of the conversation's last
// composition, sent to its own conversation's readers alone.
export const conversationSystemPromptServed = serveCollection(
  conversationSystemPrompt,
  { from: conversationSystemPromptExt },
);

/** A contributed section as appended: its text inside its wrapper. */
export function wrapSection(id: string, text: string): string {
  return `<${SYSTEM_PROMPT_SECTION_TAG} id="${id}">\n${text.trim()}\n</${SYSTEM_PROMPT_SECTION_TAG}>`;
}

/**
 * What a section that threw is replaced by: the agent learns guidance is
 * missing rather than silently running without it. The throw is reported.
 */
function failedSectionNotice(id: string, message: string): string {
  return (
    `## Context section "${id}" unavailable\n\n` +
    `This section failed to render (${message}) and has been reported. ` +
    `Its guidance is missing from this session.`
  );
}

async function renderSection(
  section: SystemPromptSection,
  conversationId: string,
): Promise<string | null> {
  try {
    return await section.render(conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[system-prompt] section "${section.id}" failed:`, err);
    reportServerError({
      message: `System-prompt section "${section.id}" failed: ${message}`,
      ...crashFieldsOf(err),
    });
    return failedSectionNotice(section.id, message);
  }
}

/**
 * Everything equin appends to Claude Code's own system prompt for one spawn of
 * the conversation's agent: its preprompt (`<special_instructions>`, first),
 * then every `SystemPrompt.Section` in id order. `undefined` when there is
 * nothing to append.
 *
 * Call it right before the process starts — never earlier (a queued spawn
 * would start on what was true when it was queued) — with the preprompt the
 * conversation runs under (its text; the caller owns that record). It records
 * what it composed, section by section, for the context card.
 *
 * A section that throws is reported and replaced by a notice: one broken
 * plugin never stops an agent from starting.
 */
export async function composeSystemPromptAppend(
  conversationId: string,
  preprompt: string | undefined,
): Promise<string | undefined> {
  const contributed = [...SystemPrompt.Section.getContributions()].sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const rendered = await Promise.all(
    contributed.map(async (s) => ({
      section: s,
      text: await renderSection(s, conversationId),
    })),
  );

  const parts: { record: SystemPromptSectionRecord; text: string }[] = [];
  if (preprompt) {
    const text = wrapPreprompt(preprompt);
    parts.push({
      record: {
        id: PREPROMPT_SECTION_ID,
        label: "Preprompt",
        chars: text.length,
      },
      text,
    });
  }
  for (const { section, text } of rendered) {
    if (text === null || text.trim() === "") continue;
    const wrapped = wrapSection(section.id, text);
    parts.push({
      record: { id: section.id, label: section.label, chars: wrapped.length },
      text: wrapped,
    });
  }

  await conversationSystemPromptExt.upsert(conversationId, {
    sections: parts.map((p) => p.record),
  });
  return parts.length === 0 ? undefined : parts.map((p) => p.text).join("\n\n");
}
