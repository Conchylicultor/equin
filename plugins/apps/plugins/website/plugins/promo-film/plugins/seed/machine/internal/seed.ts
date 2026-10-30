import { count, eq } from "drizzle-orm";
import { setConfig } from "@plugins/config_v2/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { experimentalMarksConfig } from "@plugins/framework/plugins/cli/plugins/build/plugins/experimental-marks/core";
import { db } from "@plugins/database/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { namespaceFor } from "@plugins/infra/plugins/namespace/core";
import { REPO_ROOT, checkoutRef } from "@plugins/infra/plugins/paths/server";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import {
  _attempts,
  _conversations,
  _tasks,
  createTask,
  insertPush,
} from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { tasksShortTitle } from "@plugins/tasks/plugins/task-title/server";
import { conversationProgress } from "@plugins/conversations/plugins/conversation-progress/server";
import { upsertRank } from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { recordSessionId } from "@plugins/conversations/plugins/session-chain/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { liveBlocks } from "@plugins/page/plugins/editor/server";
import { pageTools } from "@plugins/page/plugins/annotations/plugins/agent-access/server";
import { writePageTree } from "@plugins/apps/plugins/pages/plugins/fixtures/server";
import { replaceAllPlaces } from "@plugins/apps/plugins/places/plugins/places-core/server";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { writeDeployFixture } from "@plugins/apps/plugins/deploy/plugins/fixtures/server";
import {
  PROMO_FILM_COMPOSITION_ID,
  type PromoFilmSeedReport,
} from "../../core";
import { filmTaskId } from "./story/ids";
import { FILM_PAGE_IDS, FILM_PAGES } from "./story/pages";
import { FILM_PLACES } from "./story/places";
import { FILM_DEPLOY } from "./story/deploy";
import {
  DAY,
  FILM_BACKLOG,
  FILM_RUNS,
  PRACTICE_FILE,
  type FilmRun,
} from "./story/tasks";
import {
  briefTurns,
  practiceTurns,
  transcriptJsonl,
} from "./story/transcripts";
import { runWorkspace, writeWorkspace } from "./workspace";
import { writeSessionFile } from "./transcript-files";
import { ensureFilmPrototype } from "./prototype";

/** A refused seed: nothing was written. */
export class PromoFilmSeedRefused extends Error {
  constructor(message: string) {
    super(`[promo-film seed] ${message}`);
    this.name = "PromoFilmSeedRefused";
  }
}

/**
 * Write the film's story into THIS instance, through each app's own write
 * path, into a backend that is up (its jobs, files watcher and change feed
 * live, so every write derives what a user's would):
 *
 * 1. the wiki (Pages' fixture writer);
 * 2. the workspace folder the practice conversation worked in (its files);
 * 3. the task list: each run's task, attempt and conversation (backdated —
 *    no mutation can backdate, so those two are rows, as the Lumen demo writes
 *    them), its short title, category, progress, queue rank and, once landed,
 *    its push; then the backlog;
 * 4. the practice conversation's read of the Piano page, RUN through the real
 *    `read_page` tool as that conversation, and every session's transcript file;
 * 5. the saved places (the importer's own `replaceAllPlaces`, icons given);
 * 6. the Deploy history (Deploy's fixture writer);
 * 7. the Circle prototype, present or written from the committed fixture;
 * 8. the Show experimental marks setting off: this instance is built from
 *    worktree code, and the film must not show the red frame or the Wish banner.
 *
 * Refused unless this backend is the `promo-film` composition of its own
 * checkout and its database is at first launch — `./equin promo-film seed`
 * resets it just before. So a second seed is the first one again, by
 * construction.
 */
export async function seedPromoFilm(): Promise<PromoFilmSeedReport> {
  const namespace = await assertFilmInstance();
  const steps: PromoFilmSeedReport["steps"] = [];
  const note = (step: string, wrote: string) => steps.push({ step, wrote });
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);

  await writePageTree(FILM_PAGES);
  note("pages", `${FILM_PAGES.length} root pages`);

  const files = await writeWorkspace(FILM_RUNS, PRACTICE_FILE);
  note("workspace", files.join(", "));

  for (const run of FILM_RUNS) await writeRun(run, ago);
  const waiting = FILM_RUNS.filter((r) => r.status === "waiting");
  const ranks = Rank.nBetween(null, null, waiting.length);
  for (const [i, run] of waiting.entries())
    await upsertRank(run.conversationId, ranks[i]!);
  for (const task of FILM_BACKLOG)
    await createTask({
      id: filmTaskId(task.n),
      title: task.task,
      titleAuto: false,
      description: task.prompt,
      mandate: interactiveMandate,
    });
  note(
    "tasks",
    `${FILM_RUNS.length} runs (${waiting.length} waiting), ${FILM_BACKLOG.length} in the backlog`,
  );

  const readInput = { block_id: FILM_PAGE_IDS.piano };
  const readPiano = {
    input: readInput,
    result: (
      await pageTools.read(readInput, {
        conversationId: PRACTICE_FILE.conversationId,
      })
    ).content[0].text,
  };
  for (const run of FILM_RUNS) {
    const turns =
      run === PRACTICE_FILE
        ? practiceTurns(runWorkspace(run), readPiano)
        : briefTurns(run);
    const path = await writeSessionFile(
      run.sessionId,
      transcriptJsonl(run, turns, runWorkspace(run), now),
    );
    note("transcript", path);
  }

  await replaceAllPlaces(
    FILM_PLACES.map((p) => ({
      place: {
        kind: "custom" as const,
        name: p.name,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
      },
      tags: p.tags,
      note: p.note,
      createdAt: ago(p.savedDaysAgo * DAY),
      icon: parseSavedSymbolName(p.icon),
    })),
  );
  note("places", `${FILM_PLACES.length} places`);

  await writeDeployFixture(FILM_DEPLOY, new Date(now));
  note("deploy", `${FILM_DEPLOY.servers.length} server`);

  note("prototype", await ensureFilmPrototype());

  await setConfig(experimentalMarksConfig, "showExperimentalMarks", false, {
    writer: systemOrigin("promo-film seed: no experimental marks in the film"),
  });
  note("config", "experimental marks off");
  return { namespace, steps };
}

/** One agent run: its task and the rows of the attempt and conversation it ran in. */
async function writeRun(run: FilmRun, ago: (ms: number) => Date) {
  await createTask({
    id: run.taskId,
    title: run.task,
    titleAuto: false,
    description: run.prompt,
    mandate: interactiveMandate,
  });
  if (run.category !== undefined)
    await setTaskCategory(run.taskId, run.category);
  await tasksShortTitle.upsert(run.taskId, {
    shortTitle: run.shortTitle,
    sourceTitle: run.task,
  });
  await db.insert(_attempts).values({
    id: run.attemptId,
    taskId: run.taskId,
    worktreePath: runWorkspace(run),
    createdAt: ago(run.startedAgo),
    updatedAt: ago(run.updatedAgo),
  });
  await db.insert(_conversations).values({
    id: run.conversationId,
    attemptId: run.attemptId,
    title: run.title,
    status: run.status,
    workingOn: null,
    model: run.model,
    claudeSessionId: run.sessionId,
    createdAt: ago(run.startedAgo),
    updatedAt: ago(run.updatedAgo),
    endedAt: run.landed === undefined ? null : ago(run.landed.ago),
    lastViewedAt: ago(run.updatedAgo),
  });
  await recordSessionId(run.conversationId, run.sessionId);
  await conversationProgress.upsert(run.conversationId, {
    phase: run.phase,
    source: run.phase === "pushed" ? "push" : "heuristic",
  });
  if (run.landed !== undefined)
    await insertPush({
      id: `push-film-${run.n}`,
      attemptId: run.attemptId,
      conversationId: run.conversationId,
      sha: run.landed.sha,
      pushId: `push-film-${run.n}`,
      message: run.title,
      createdAt: ago(run.landed.ago),
    });
}

/**
 * This backend is the `promo-film` composition of its own checkout, and its
 * database is at first launch (no task, no film page). Loud otherwise, before
 * anything is written.
 */
async function assertFilmInstance(): Promise<string> {
  const here = runtimeNamespace();
  const film = namespaceFor(
    PROMO_FILM_COMPOSITION_ID,
    await checkoutRef(REPO_ROOT),
  );
  if (here !== film)
    throw new PromoFilmSeedRefused(
      `this backend is "${here}", not the film's instance "${film}" — the seed writes only into the promo-film composition's own database`,
    );
  const [tasks] = await db.select({ n: count() }).from(_tasks);
  const [pages] = await db
    .select({ n: count() })
    .from(liveBlocks)
    .where(eq(liveBlocks.id, FILM_PAGE_IDS.piano));
  if ((tasks?.n ?? 0) > 0 || (pages?.n ?? 0) > 0)
    throw new PromoFilmSeedRefused(
      `"${here}" is not at first launch (${tasks?.n ?? 0} tasks, film page ${pages?.n ? "present" : "absent"}) — run \`./equin promo-film seed\`, which resets it first`,
    );
  return here;
}
