import { serveCollection } from "@plugins/network/plugins/live/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import {
  wrapContextSection,
  wrapPreprompt,
} from "@plugins/conversations/plugins/transcript-source/core";
import {
  conversationSystemPrompt,
  PREPROMPT_SECTION_ID,
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

/** Every contributed section, in id order (the order they are joined in). */
function sectionsInOrder(): SystemPromptSection[] {
  return [...SystemPrompt.Section.getContributions()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function renderSections(
  sections: readonly SystemPromptSection[],
  conversationId: string,
): Promise<{ section: SystemPromptSection; text: string | null }[]> {
  return Promise.all(
    sections.map(async (section) => ({
      section,
      text: await renderSection(section, conversationId),
    })),
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
  const rendered = await renderSections(sectionsInOrder(), conversationId);

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
    const wrapped = wrapContextSection(section.id, section.label, text);
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

/** One section, as a change notice re-sends it to a running agent. */
export type SectionRefresh =
  /** What it says now, wrapped as in the system prompt (`<equin-context>`). */
  | { kind: "current"; id: string; label: string; text: string }
  /** It was in the agent's system prompt and now renders nothing: drop it. */
  | { kind: "withdrawn"; id: string; label: string };

/**
 * What the sections `pick` selects say now, for a running agent whose system
 * prompt was fixed at its spawn — rendered again in id order: what each says
 * now, or that one the agent's system prompt carried (its last spawn's
 * record) no longer applies. A section empty both then and now is left out.
 * The mandate change notice picks every section that `followsMandate`; the
 * owner of another change picks its own section. Renders exactly as a spawn
 * would (a throwing section is reported and replaced by its notice); the
 * record is left alone — it says what the process was started with.
 */
export async function refreshSections(
  conversationId: string,
  pick: (section: SystemPromptSection) => boolean,
): Promise<SectionRefresh[]> {
  const [rendered, record] = await Promise.all([
    renderSections(sectionsInOrder().filter(pick), conversationId),
    conversationSystemPromptExt.get(conversationId),
  ]);
  const carried = new Set(record?.sections.map((s) => s.id) ?? []);
  const out: SectionRefresh[] = [];
  for (const { section, text } of rendered) {
    const { id, label } = section;
    if (text !== null && text.trim() !== "")
      out.push({
        kind: "current",
        id,
        label,
        text: wrapContextSection(id, label, text),
      });
    else if (carried.has(id)) out.push({ kind: "withdrawn", id, label });
  }
  return out;
}
