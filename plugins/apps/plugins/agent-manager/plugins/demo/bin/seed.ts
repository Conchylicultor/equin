import { and, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  setTaskCategory,
  TaskCategory,
} from "@plugins/tasks/plugins/task-category/server";
import {
  _attempts,
  _conversations,
  createTask,
  insertPush,
} from "@plugins/tasks/plugins/tasks-core/server";
import { upsertRank } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { writeTranscript } from "@plugins/conversations/plugins/transcript-source/plugins/memory/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { setTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import { tasksShortTitle } from "@plugins/tasks/plugins/task-title/server";
import { conversationNotes } from "@plugins/conversations/plugins/conversation-view/plugins/notes/server";
import { conversationProgress } from "@plugins/conversations/plugins/conversation-progress/server";
import {
  _agent_launches,
  _agents,
  nextAgentRankUnder,
} from "@plugins/conversations/plugins/agents/server";
import {
  applyPageBlockPatch,
  liveBlocks,
  PAGE_BLOCK_TYPE,
  type Block,
} from "@plugins/page/plugins/editor/server";
import { dropBlankLinesBesideTags } from "@plugins/page/plugins/editor/core";
import {
  applyMarkdownToBlock,
  readBlockAsMarkdown,
  serverMarkdownContext,
  type ApplyReport,
} from "@plugins/page/plugins/markdown-apply/server";
import { splitPageMeta } from "@plugins/page/plugins/markdown-apply/core";
import { reindexPage } from "@plugins/page/plugins/links/server";
import {
  resolveTagNames,
  writeResolvedPageTags,
} from "@plugins/page/plugins/tags/server";
import { promptBlock } from "@plugins/page/plugins/prompt/plugins/link/server";
import { recordAgentNotesAuthor } from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/server";
import { agentNotesBlock } from "@plugins/page/plugins/annotations/plugins/agent-notes/core";
import { setPageStarred } from "@plugins/apps/plugins/pages/plugins/starred/server";
import { reindexPageSearch } from "@plugins/apps/plugins/pages/plugins/content-search/server";
import {
  DARK_MODE_PAGE_WORK,
  DEMO_AGENTS,
  DEMO_PAGE_IDS,
  DEMO_PAGES,
  DEMO_STORIES,
  demoAgentId,
  demoAgentLaunchId,
  demoAttemptId,
  demoConversationId,
  demoPromptOf,
  demoStoryByKey,
  demoTaskId,
  demoTranscriptJsonl,
  demoWorktreePath,
  type DemoNode,
  type DemoPage,
  type DemoPageSession,
  type DemoPrototypeData,
} from "../core";
import { seedPrototypes } from "./seed-prototypes";

/**
 * The demo's starting data on the freshly migrated database, one agent per
 * story (`../core`): its task and category, the attempt and conversation it
 * runs in — backdated to the story's clock, which no mutation can do, so those
 * two are inserted as rows — its place in the queue, its transcript as Claude
 * Code JSONL, and, for a finished story, the push that landed it; its short
 * title, track, progress and note; and the roster of agents with the launch of
 * each story an agent filed. Then the Lumen workspace (`../core`'s pages) with
 * the dark-mode story's origin on it, and the page work that agent did, RUN
 * ({@link seedPages}) — after which each transcript is written, the dark-mode
 * one recording that run. Last, the Prototypes gallery's prototypes, their
 * histories and thumbnails ({@link seedPrototypes}), from `prototypes` — the
 * committed `../data/`, inlined into the worker's bundle or read off disk by
 * the boot test.
 */
export async function seed(prototypes: DemoPrototypeData): Promise<void> {
  assertStoryCategoriesRegistered();
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const live = DEMO_STORIES.filter((s) => s.status !== "done");
  const ranks = Rank.nBetween(null, null, live.length);
  for (const agent of DEMO_AGENTS) {
    await db.insert(_agents).values({
      id: demoAgentId(agent),
      parentId: null,
      name: agent.name,
      prompt: agent.prompt,
      model: null,
      icon: null,
      iconColor: null,
      rank: (await nextAgentRankUnder(null)).toJSON(),
    });
  }
  for (const story of DEMO_STORIES) {
    const taskId = demoTaskId(story);
    const attemptId = demoAttemptId(story);
    const conversationId = demoConversationId(story);
    await createTask({
      id: taskId,
      title: story.task,
      titleAuto: false,
      ...(story.prompt === undefined ? {} : { description: story.prompt }),
    });
    if (story.category !== undefined)
      await setTaskCategory(taskId, story.category);
    await tasksShortTitle.upsert(taskId, {
      shortTitle: story.shortTitle,
      sourceTitle: story.task,
    });
    if (story.track !== undefined) await setTaskTrack(taskId, story.track);
    await db.insert(_attempts).values({
      id: attemptId,
      taskId,
      worktreePath: demoWorktreePath(story),
      createdAt: ago(story.startedAgo),
      updatedAt: ago(story.updatedAgo),
    });
    await db.insert(_conversations).values({
      id: conversationId,
      attemptId,
      title: story.title,
      status: story.status,
      workingOn: story.status === "working" ? "turn" : null,
      model: story.model,
      createdAt: ago(story.startedAgo),
      updatedAt: ago(story.updatedAgo),
      endedAt: story.endedAgo === undefined ? null : ago(story.endedAgo),
      lastViewedAt: ago(story.updatedAgo),
    });
    await conversationProgress.upsert(conversationId, {
      phase: story.phase,
      source: story.phase === "pushed" ? "push" : "heuristic",
    });
    if (story.note !== undefined)
      await conversationNotes.upsert(conversationId, { notes: story.note });
    if (story.agent !== undefined) {
      const agent = DEMO_AGENTS.find((a) => a.key === story.agent);
      if (agent === undefined)
        throw new Error(
          `demo story "${story.key}" names agent "${story.agent}", which DEMO_AGENTS does not list`,
        );
      await db.insert(_agent_launches).values({
        id: demoAgentLaunchId(story),
        agentId: demoAgentId(agent),
        taskId,
        createdAt: ago(story.startedAgo),
      });
    }
    if (story.endedAgo !== undefined)
      await insertPush({
        id: `push-demo-${story.key}`,
        attemptId,
        conversationId,
        sha: `demo${story.key}`.padEnd(40, "0").slice(0, 40),
        pushId: `push-demo-${story.key}`,
        message: story.title,
        createdAt: ago(story.endedAgo),
      });
  }
  for (const [i, story] of live.entries())
    await upsertRank(demoConversationId(story), ranks[i]!);
  const session = await seedPages();
  for (const story of DEMO_STORIES)
    await writeTranscript(
      demoConversationId(story),
      demoTranscriptJsonl(story, now, session),
    );
  await seedPrototypes(prototypes);
}

const DARK_MODE = demoStoryByKey("dark-mode");

/**
 * The Lumen workspace, then what the dark-mode agent did on it.
 *
 * Event triggers are synced only in `onReady`, after the seed, so nothing
 * derived from a page runs by itself here: the seed calls each derivation —
 * the backlinks edges, the search docs — directly, once the pages exist and
 * again once the agent has written.
 *
 * The agent's work is RUN the way the page tools run it
 * (`page/annotations/agent-access`'s `read_page` / `edit_page` /
 * `write_agent_note`): the reads are `readBlockAsMarkdown(…, { meta: true })`,
 * the edit splices the read and applies it against that read as baseline, the
 * note rewrites the card it minted, and the conversation is stamped onto both
 * agent-authored blocks after the commit. The tools' human-audience redaction
 * and inert-paragraph rule are identities here — the seeded pages hold no
 * private card and no empty paragraph — so their results are what the tools
 * would have returned, recorded as the transcript's tool results.
 */
async function seedPages(): Promise<DemoPageSession> {
  const now = new Date();
  await applyPageBlockPatch(null, {
    creates: forestRows(DEMO_PAGES, null, null, now),
    updates: [],
    deleteIds: [],
  });
  const pages = DEMO_PAGES.flatMap(pagesIn);
  for (const page of pages) await reindexPage(page.id);
  for (const page of pages) await reindexPageSearch(page.id);
  for (const page of pages) {
    if (page.tags !== undefined) {
      const resolved = await resolveTagNames(
        page.tags.map((t) => ({ name: t.name, create: { color: t.color } })),
      );
      if (!resolved.ok)
        throw new Error(
          `[demo seed] page ${page.id}'s tags did not resolve: ${JSON.stringify(resolved.unknown)}`,
        );
      await writeResolvedPageTags(page.id, resolved.tags);
    }
    if (page.starred) await setPageStarred(page.id, true);
  }
  // The dark-mode task was launched from the Bugs page's prompt block.
  await promptBlock.upsert(demoTaskId(DARK_MODE), {
    pageId: DEMO_PAGE_IDS.bugs,
    blockId: DEMO_PAGE_IDS.prompt,
  });

  const conversationId = demoConversationId(DARK_MODE);
  const read = async (blockId: string) => ({
    input: { block_id: blockId },
    result: await readBlockAsMarkdown(blockId, { meta: true }),
  });
  const readOrigin = await read(DEMO_PAGE_IDS.bugs);
  const readSpec = await read(DEMO_PAGE_IDS.spec);

  // edit_page on Bugs: the cause card and the investigation page, spliced in
  // after the prompt's line of the read, applied against the read's body.
  const split = splitPageMeta(readOrigin.result);
  if (!split.ok || split.meta === null)
    throw new Error(
      `[demo seed] read_page of ${DEMO_PAGE_IDS.bugs} opened with no <page-meta> header`,
    );
  const body = split.rest;
  const oldString = promptLineOf(body, demoPromptOf(DARK_MODE));
  const newString = dropBlankLinesBesideTags(
    [
      oldString,
      DARK_MODE_PAGE_WORK.card,
      DARK_MODE_PAGE_WORK.investigation,
    ].join("\n"),
    serverMarkdownContext().handles,
  );
  const edited = await applyMarkdownToBlock(
    DEMO_PAGE_IDS.bugs,
    body.replace(oldString, () => newString),
    { baseline: body },
  );
  const investigationId = only(edited.createdPageIds, "page the edit minted");
  const cardId = only(
    (
      await db
        .select({ id: liveBlocks.id })
        .from(liveBlocks)
        .where(
          and(
            inArray(liveBlocks.id, edited.createdIds),
            eq(liveBlocks.type, agentNotesBlock.type),
          ),
        )
    ).map((r) => r.id),
    "card the edit minted",
  );
  await recordAgentNotesAuthor(cardId, conversationId);
  await recordAgentNotesAuthor(investigationId, conversationId);

  // write_agent_note on the card, once the fix passed.
  const noted = await applyMarkdownToBlock(
    cardId,
    DARK_MODE_PAGE_WORK.cardDone,
  );
  await recordAgentNotesAuthor(cardId, conversationId);

  for (const pageId of [DEMO_PAGE_IDS.bugs, investigationId]) {
    await reindexPage(pageId);
    await reindexPageSearch(pageId);
  }

  return {
    readOrigin,
    readSpec,
    edit: {
      input: {
        block_id: DEMO_PAGE_IDS.bugs,
        old_string: oldString,
        new_string: newString,
      },
      result: JSON.stringify({
        ...applySummary(edited, [cardId, investigationId]),
        replaced: 1,
      }),
    },
    note: {
      input: { block_id: cardId, content: DARK_MODE_PAGE_WORK.cardDone },
      result: JSON.stringify(applySummary(noted, [cardId])),
    },
    cardId,
    investigationId,
  };
}

/** `nodes` as the editor's rows, parent first, under `parentId` in page `pageId`. */
function forestRows(
  nodes: readonly DemoNode[],
  parentId: string | null,
  pageId: string | null,
  now: Date,
): Block[] {
  const ranks = Rank.nBetween(null, null, nodes.length);
  return nodes.flatMap((node, i): Block[] => {
    const row = {
      id: node.id,
      parentId,
      pageId,
      rank: ranks[i]!,
      expanded: true,
      createdAt: now,
      updatedAt: now,
    };
    if (node.type === PAGE_BLOCK_TYPE)
      return [
        { ...row, type: node.type, data: { title: node.title, icon: null } },
        ...forestRows(node.children, node.id, node.id, now),
      ];
    const text = [{ text: node.text }];
    return [
      {
        ...row,
        type: node.type,
        data:
          node.type === "to-do" ? { text, checked: node.checked } : { text },
      },
    ];
  });
}

/** `page` and every page below it, in document order. */
function pagesIn(page: DemoPage): DemoPage[] {
  return [
    page,
    ...page.children.flatMap((c) =>
      c.type === PAGE_BLOCK_TYPE ? pagesIn(c) : [],
    ),
  ];
}

/** The one line of `body` holding the prompt's text — loud unless exactly one. */
function promptLineOf(body: string, prompt: string): string {
  const lines = body.split("\n").filter((l) => l.includes(prompt));
  if (lines.length !== 1)
    throw new Error(
      `[demo seed] expected one line of the Bugs page read to hold the prompt, found ${lines.length}:\n${body}`,
    );
  return lines[0]!;
}

function only(ids: readonly string[], what: string): string {
  if (ids.length !== 1)
    throw new Error(
      `[demo seed] expected one ${what}, found ${ids.length}: ${ids.join(", ")}`,
    );
  return ids[0]!;
}

/**
 * An apply's report as the page tools return it — the shape of
 * `agent-access`'s private `applySummary`, which the transcript's page-tool
 * renderers and artifacts parse (`parsePageApplyReport`). The inert-paragraph
 * note is absent: the tools add it only when an apply left empty paragraphs
 * alone, which these never do.
 */
function applySummary(report: ApplyReport, noteIds: readonly string[]) {
  return {
    scope_id: report.rootId,
    page_id: report.pageId,
    note_ids: noteIds,
    survived: report.stats.survived,
    created: report.stats.created,
    deleted: report.stats.deleted,
    moved: report.stats.moved,
    text_edited: report.textEditedIds.length,
    created_ids: report.createdIds,
    created_page_ids: report.createdPageIds,
    absorbed_writes: report.absorbedWrites,
  };
}

/**
 * Every story's category is one this host registers (`TaskCategory`): a task
 * filed under a category no booted plugin registers renders as its raw id —
 * the demo's task list would group under "apps" instead of a label. Loud, at
 * seed, so the boot test fails the moment the composition drops a registrar.
 */
function assertStoryCategoriesRegistered(): void {
  const registered = new Set(TaskCategory.getContributions().map((c) => c.id));
  const missing = [
    ...new Set(
      DEMO_STORIES.flatMap((s) =>
        s.category !== undefined && !registered.has(s.category)
          ? [s.category]
          : [],
      ),
    ),
  ];
  if (missing.length > 0) {
    throw new Error(
      `[demo seed] stories are filed under task categories this host does not register: ${missing.join(", ")} (registered: ${[...registered].sort().join(", ")}). File them under a category a graph member contributes (TaskCategory), or bring its registrar into the composition.`,
    );
  }
}
