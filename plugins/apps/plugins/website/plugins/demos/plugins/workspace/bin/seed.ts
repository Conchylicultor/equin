import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
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
import { promptBlock } from "@plugins/page/plugins/prompt/plugins/link/server";
import { pageTools } from "@plugins/page/plugins/annotations/plugins/agent-access/server";
import { writePageTree } from "@plugins/apps/plugins/pages/plugins/fixtures/server";
import type { PrototypeFixtureData } from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";
import { writePrototypeFixture } from "@plugins/apps/plugins/prototypes/plugins/fixtures/server";
import { writeSongFixtures } from "@plugins/apps/plugins/sonata/plugins/fixtures/server";
import { writePlacesFixture } from "@plugins/apps/plugins/places/plugins/fixtures/server";
import { settleJobQueue } from "@plugins/infra/plugins/jobs/plugins/in-process/server";
import { eq } from "drizzle-orm";
import {
  readEndpointResponse,
  sendEndpointRequest,
} from "@plugins/infra/plugins/endpoints/core";
import { pageData, updateBlock } from "@plugins/page/plugins/editor/core";
import { liveBlocks } from "@plugins/page/plugins/editor/server";
import {
  PRACTICE_TIMER_PAGE_WORK,
  DEMO_AGENTS,
  DEMO_PAGE_IDS,
  DEMO_PAGES,
  DEMO_PLACES,
  DEMO_SONGS,
  DEMO_STORIES,
  demoAgentId,
  demoAgentLaunchId,
  demoAttemptId,
  demoConversationId,
  demoPromptOf,
  demoStoryByKey,
  demoTaskId,
  demoTranscriptJsonl,
  demoPrototypeFixture,
  demoWorktreePath,
  type DemoPageSession,
  type DemoPageToolCall,
} from "../core";

/**
 * The demo's starting data, written into a LIVE host (`bootBrowserHost` seeds
 * after the post-ready phases: triggers synced, the job queue and the files
 * watchers running), so every write derives what a user's would — the seed
 * calls no derivation itself, it settles the queue (`settleJobQueue`) where
 * the next step reads what the last one queued. In order:
 *
 * 1. Demo's workspace (`../core`'s pages), through Pages' fixture writer
 *    (`writePageTree`) — its backlinks, search docs and history snapshots
 *    derive from the write, and are settled;
 * 2. the stories, one agent per story (`../core`): its task and category, the
 *    attempt and conversation it runs in — backdated to the story's clock,
 *    which no mutation can do, so those two are inserted as rows — its place
 *    in the queue, and, for a finished story, the push that landed it; its
 *    short title, track, progress and note; the roster of agents with the
 *    launch of each story an agent filed; the practice-timer task's origin,
 *    My equin's prompt block;
 * 3. the page work the practice-timer agent did, RUN through the real page
 *    tools ({@link runPracticeTimerPageWork}), then settled; then the user
 *    decorating the page it minted with an icon, through the page header's own
 *    write ({@link decoratePlanPage}) — an agent's tools cannot set one;
 * 4. each conversation's transcript, the practice-timer one recording that run;
 * 5. the Prototypes gallery, through Prototypes' fixture writer
 *    (`writePrototypeFixture`) from `prototypes` — the committed `../data/`,
 *    inlined into the worker's bundle or read off disk by the boot test — then
 *    settled;
 * 6. the Sonata library's songs (`../core`'s), through Sonata's fixture writer
 *    (`writeSongFixtures`), beside the MIDI starters the MIDI source seeds;
 * 7. Demo's Places map (`../core`'s), through Places' fixture writer
 *    (`writePlacesFixture`): its tags through the tag tree's endpoints on the
 *    host, its places through the app's one insert, icons given.
 */
const PRACTICE_TIMER = demoStoryByKey("practice-timer");

export async function seed(
  prototypes: PrototypeFixtureData,
  host: { request(req: Request): Promise<Response> },
): Promise<void> {
  assertStoryCategoriesRegistered();
  await writePageTree(DEMO_PAGES);
  await settleJobQueue();
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
      mandate: interactiveMandate,
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
  // The practice-timer task was launched from My equin's prompt block.
  await promptBlock.upsert(demoTaskId(PRACTICE_TIMER), {
    pageId: DEMO_PAGE_IDS.myEquin,
    blockId: DEMO_PAGE_IDS.prompt,
  });

  const session = await runPracticeTimerPageWork();
  await decoratePlanPage(host, session.planId);
  await settleJobQueue();
  for (const story of DEMO_STORIES)
    await writeTranscript(
      demoConversationId(story),
      demoTranscriptJsonl(story, now, session),
    );

  await writePrototypeFixture(demoPrototypeFixture(prototypes));
  await settleJobQueue();
  await writeSongFixtures(DEMO_SONGS);
  await settleJobQueue();
  await writePlacesFixture(DEMO_PLACES, host);
  await settleJobQueue();
}

/**
 * What the practice-timer agent did on Demo's workspace, RUN through the page
 * tools' own handlers (`page/annotations/agent-access`'s `pageTools`, what the
 * MCP tools `read_page` / `edit_page` / `write_agent_note` call) as that
 * agent's conversation: read My equin, the page it was launched from (which
 * delivers the page's instructions for agents), and the spec it links, mint
 * the plan card and the plan page beside the prompt (`edit_page`), then
 * rewrite the card once the tests passed (`write_agent_note`). Each call's input and exact result are recorded for
 * the transcript, and the ids the edit minted are read from its own report —
 * so the transcript cannot drift from the pages it left, and the authorship
 * stamps, redaction and instructions gate are the tools' own.
 */
async function runPracticeTimerPageWork(): Promise<DemoPageSession> {
  const caller = { conversationId: demoConversationId(PRACTICE_TIMER) };
  const text = (result: { content: [{ text: string }] }) =>
    result.content[0].text;

  const read = async (blockId: string): Promise<DemoPageToolCall> => {
    const input = { block_id: blockId };
    return { input, result: text(await pageTools.read(input, caller)) };
  };
  const readOrigin = await read(DEMO_PAGE_IDS.myEquin);
  const readSpec = await read(DEMO_PAGE_IDS.spec);

  // edit_page on My equin: the plan card and the plan page, after the
  // prompt's line of the read.
  const promptLine = promptLineOf(
    readOrigin.result,
    demoPromptOf(PRACTICE_TIMER),
  );
  const editInput = {
    block_id: DEMO_PAGE_IDS.myEquin,
    old_string: promptLine,
    new_string: [
      promptLine,
      PRACTICE_TIMER_PAGE_WORK.card,
      PRACTICE_TIMER_PAGE_WORK.plan,
    ].join("\n"),
    replace_all: false,
  };
  const edit = {
    input: editInput,
    result: text(await pageTools.edit(editInput, caller)),
  };
  const minted = editReport(edit.result);
  const planId = only(minted.created_page_ids, "page the edit minted");
  const cardId = only(
    minted.note_ids.filter((id) => id !== planId),
    "card the edit minted",
  );

  // write_agent_note on the card, once the tests passed.
  const noteInput = {
    block_id: cardId,
    content: PRACTICE_TIMER_PAGE_WORK.cardDone,
  };
  const note = {
    input: noteInput,
    result: text(await pageTools.writeNote(noteInput, caller)),
  };

  return { readOrigin, readSpec, edit, note, cardId, planId };
}

/**
 * The user, afterwards, picking an icon for the page the agent minted — the
 * page header's own write (`apps/pages/page-tree`'s `useSavePageData`): the
 * `PATCH` of the block's data, its current data spread under the new icon,
 * sent through the host's router as the page would send it. An agent's page
 * tools cannot set an icon; a person can, on an agent's page too.
 */
async function decoratePlanPage(
  host: { request(req: Request): Promise<Response> },
  pageId: string,
): Promise<void> {
  const [row] = await db
    .select({ data: liveBlocks.data })
    .from(liveBlocks)
    .where(eq(liveBlocks.id, pageId))
    .limit(1);
  if (row === undefined)
    throw new Error(
      `[demo seed] the minted page ${pageId} is not a live block`,
    );
  const res = await sendEndpointRequest(
    (path, init) =>
      host.request(
        new Request(new URL(path, "http://demo-seed.invalid"), init),
      ),
    updateBlock,
    { id: pageId },
    {
      body: {
        data: { ...pageData(row), icon: PRACTICE_TIMER_PAGE_WORK.planIcon },
      },
    },
  );
  await readEndpointResponse(updateBlock, res);
}

/** The ids an `edit_page` result reports — loud on a result of another shape. */
function editReport(result: string): {
  note_ids: string[];
  created_page_ids: string[];
} {
  const report = JSON.parse(result) as Record<string, unknown>;
  const ids = (key: string): string[] => {
    const value = report[key];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
      throw new Error(
        `[demo seed] edit_page's result has no string list "${key}": ${result}`,
      );
    return value;
  };
  return {
    note_ids: ids("note_ids"),
    created_page_ids: ids("created_page_ids"),
  };
}

/** The one line of `read` holding the prompt's text — loud unless exactly one. */
function promptLineOf(read: string, prompt: string): string {
  const lines = read.split("\n").filter((l) => l.includes(prompt));
  if (lines.length !== 1)
    throw new Error(
      `[demo seed] expected one line of the My equin read to hold the prompt, found ${lines.length}:\n${read}`,
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
