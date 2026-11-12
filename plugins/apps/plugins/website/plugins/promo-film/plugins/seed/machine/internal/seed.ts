import { z } from "zod";
import { count, desc, eq, or, sql } from "drizzle-orm";
import {
  getConfig,
  getDescriptorByStorePath,
  setConfig,
  setConfigByPath,
} from "@plugins/config_v2/server";
import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/machine";
import { placeDetails } from "@plugins/integrations/plugins/google-maps/plugins/places-api/machine";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { experimentalMarksConfig } from "@plugins/framework/plugins/cli/plugins/build/plugins/experimental-marks/core";
import { db } from "@plugins/database/server";
import { insertWithUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { namespaceFor } from "@plugins/infra/plugins/namespace/core";
import {
  displayPath,
  homeFolderConfig,
  profileNameConfig,
} from "@plugins/infra/plugins/host-account/core";
import { checkoutRef } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
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
import {
  rankForTop,
  upsertRank,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/server";
import { recordSessionId } from "@plugins/conversations/plugins/session-chain/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { filesConfig } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { liveBlocks } from "@plugins/page/plugins/editor/server";
import { pageTools } from "@plugins/page/plugins/annotations/plugins/agent-access/server";
import { writePageTree } from "@plugins/apps/plugins/pages/plugins/fixtures/server";
import { replaceAllPlaces } from "@plugins/apps/plugins/places/plugins/places-core/server";
import { parseSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { writeDeployFixture } from "@plugins/apps/plugins/deploy/plugins/fixtures/server";
import { WISHES_CATEGORY_ID } from "@plugins/wish/core";
import { ConversationModelSchema } from "@plugins/conversations/plugins/model-provider/core";
import {
  APP_LAYOUT,
  filmAppLayout,
  filmNowAfter,
  PIANO_SHOP_LIST,
  PIANO_SHOPS_ADDED,
  PROMO_FILM_COMPOSITION_ID,
  SONATA_KEY_SECTION,
  SONATA_SECTION_LAYOUT,
  type PromoFilmSeedReport,
} from "../../core";
import {
  filmAttemptId,
  filmConversationId,
  filmSessionId,
  filmTaskId,
} from "./story/ids";
import { FILM_PAGE_IDS, FILM_PAGES, PIANO_NOTE_ANCHOR } from "./story/pages";
import { FILM_PLACES } from "./story/places";
import { FILM_MAIN_COMMITS_NEEDED, filmDeploy } from "./story/deploy";
import { readMainCommits } from "./story/main-commits";
import {
  DAY,
  FILM_BACKLOG,
  FILM_RUNS,
  GRIEG_RUN,
  MIN,
  type FilmRun,
} from "./story/tasks";
import {
  briefTurns,
  GRIEG_NOTE,
  griegTurns,
  prototypeTurns,
  transcriptJsonl,
  type ToolRun,
} from "./story/transcripts";
import { rm } from "node:fs/promises";

import {
  pianoFolder,
  runWorkspace,
  writeFilmClock,
  writeHomeFolder,
  standInHomeFolder,
  writeRunCheckout,
  commonGitDir,
  writeWorkspace,
} from "./workspace";
import { writeSessionFile } from "./transcript-files";
import { circleFirstVersionHtml, ensureFilmPrototype } from "./prototype";

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
 * 1. the workspace (Pages' fixture writer): an organised, nested tree;
 * 2. the folder the Grieg conversation worked in (the score and the MIDI);
 * 3. the task list: each run's task, attempt and conversation (backdated —
 *    no mutation can backdate, so those two are rows, as the workspace demo writes
 *    them), its short title, category, progress, queue rank and, once landed,
 *    its push; then the backlog;
 * 4. the Grieg conversation's read of the Piano page and its note there, both
 *    RUN through the real page tools as that conversation (so the note records
 *    the conversation that wrote it), and every session's transcript file;
 * 5. the saved places: real Google places by id, their details fetched and
 *    written as the importer does (`replaceAllPlaces`, icons given);
 * 6. the Deploy history (Deploy's fixture writer);
 * 7. the Circle prototype, present or written from the committed fixture;
 * 8. Sonata's Current key section hidden (its slot layout's user layer), and
 *    Circle hidden from the launchers (the app layout's user layer);
 * 9. the Show experimental marks setting off: this instance is built from
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
  // The film's instant, not the seed's: the story's "x ago" read from the day
  // and hour the film is set on (film-clock), which the recording pins.
  const now = filmNowAfter(Date.now());
  const ago = (ms: number) => new Date(now - ms);

  await writePageTree(FILM_PAGES, new Date(now));
  note("pages", `${FILM_PAGES.length} root pages`);

  const files = await writeWorkspace(FILM_RUNS, GRIEG_RUN);
  note("workspace", files.join(", "));
  await writeFilmClock({ now });
  note("film clock", new Date(now).toISOString());
  note("files", await writeHomeFolder(now));

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

  const caller = { conversationId: GRIEG_RUN.conversationId };
  const readInput = { block_id: FILM_PAGE_IDS.piano };
  const pianoText = (await pageTools.read(readInput, caller)).content[0].text;
  const readPiano: ToolRun = { input: readInput, result: pianoText };
  const anchor = pianoText
    .split("\n")
    .find((line) => line.includes(PIANO_NOTE_ANCHOR));
  if (anchor === undefined)
    throw new Error(
      `[promo-film seed] the Piano page has no "${PIANO_NOTE_ANCHOR}" line to write the agent's note after`,
    );
  const noteInput = {
    block_id: FILM_PAGE_IDS.piano,
    old_string: anchor,
    new_string: `${anchor}\n<agent-inline>\n${GRIEG_NOTE}\n</agent-inline>`,
    replace_all: false,
  };
  const notePiano: ToolRun = {
    input: noteInput,
    result: (await pageTools.edit(noteInput, caller)).content[0].text,
  };
  note("note", "the Grieg conversation's note on the Piano page");
  for (const run of FILM_RUNS) {
    const turns =
      run === GRIEG_RUN
        ? griegTurns(runWorkspace(run), readPiano, notePiano)
        : briefTurns(run);
    const path = await writeSessionFile(
      runWorkspace(run),
      run.sessionId,
      transcriptJsonl(run, turns, runWorkspace(run), now),
    );
    note("transcript", path);
  }

  // The importer's path: every snapshot fetched BEFORE the write (one Place
  // Details call per place, on the host's Places key), then one transaction.
  const maps = await getPlacesClient();
  if (!maps.ok)
    throw new PromoFilmSeedRefused(
      "the host has no Google Places key (Settings → Accounts → Google Maps): the film's places are real Google places, saved by id",
    );
  const snapshots = await Promise.all(
    FILM_PLACES.map((p) => placeDetails(maps.client, p.googlePlaceId)),
  );
  await replaceAllPlaces(
    FILM_PLACES.map((p, i) => ({
      place: { kind: "google" as const, snapshot: snapshots[i]! },
      tags: p.tags,
      note: p.note,
      createdAt: ago(p.savedDaysAgo * DAY),
      icon: parseSavedSymbolName(p.icon),
    })),
  );
  note("places", `${FILM_PLACES.length} places`);

  const filmDeployState = filmDeploy(
    await readMainCommits(FILM_MAIN_COMMITS_NEEDED),
  );
  await writeDeployFixture(filmDeployState, new Date(now));
  note("deploy", `${filmDeployState.servers.length} server`);

  note("prototype", await ensureFilmPrototype());

  // Sonata's Current key section and Circle's app start hidden — each its
  // slot layout's own `hidden` flag, in the user layer — so the film brings
  // them back with the same config write an agent makes (Sonata's: a reset of
  // its layout to the committed one; Circle's, film-only and so named by no
  // committed layout: this layout with the flag dropped, `filmAppLayout`).
  await hideLayoutItem(
    SONATA_SECTION_LAYOUT,
    SONATA_KEY_SECTION,
    "Sonata's Current key section hidden",
  );
  note("config", "Sonata's Current key section hidden");
  await setConfigByPath(
    APP_LAYOUT,
    "items",
    filmAppLayout(layoutItems(APP_LAYOUT), "hidden"),
    {
      writer: systemOrigin(
        "promo-film seed: Circle after Browser, hidden until the film shows it",
      ),
    },
  );
  note("config", "Circle after Browser, hidden");

  // Home is a stand-in folder of the film's own (the machine's real home is
  // never shown); Files opens on its Music/Piano folder (its start folder).
  await setConfig(homeFolderConfig, "standIn", standInHomeFolder(), {
    writer: systemOrigin("promo-film seed: a stand-in home folder"),
  });
  note("config", "Home is the film's stand-in home folder");
  await setConfig(
    filesConfig,
    "startFolder",
    displayPath(pianoFolder(), standInHomeFolder()),
    {
      writer: systemOrigin("promo-film seed: Files opens on the Piano folder"),
    },
  );
  note("config", "Files start folder: the Piano folder");

  await setConfig(experimentalMarksConfig, "showExperimentalMarks", false, {
    writer: systemOrigin("promo-film seed: no experimental marks in the film"),
  });
  note("config", "experimental marks off");

  // No person's name on screen — not the machine's account, not an invented
  // one: the user's name turned off (Settings → Config), so the Pages
  // workspace reads "My pages" and the Claude accounts are numbered.
  await setConfig(profileNameConfig, "showName", false, {
    writer: systemOrigin("promo-film seed: no personal name on screen"),
  });
  note("config", "the user's name hidden (Settings → Config)");
  return { namespace, steps };
}

/**
 * The agent run behind a task the film's Wish filed, as the agent would have
 * left it: the film's instance never launches one, so the recording asks for
 * it while it plays the time-lapse. The task is the one the Wish really
 * created — the newest whose description is `prompt` (plus the page it was
 * filed from, when the Wish's Page URL was on) — and the run is written
 * through the same rows and transcript file as the seeded ones, its
 * conversation waiting on the user.
 */
export async function finishFilmAgentRun(
  prompt: string,
  /** The page's now (epoch ms): the film's calendar, which the run just finished on. */
  now: number,
): Promise<{ taskId: string; conversationId: string }> {
  await assertFilmNamespace();
  const [task] = await db
    .select({ id: _tasks.id })
    .from(_tasks)
    // The Wish files the prompt as typed, then — with its Page URL on — the
    // page under a rule (tasks' renderTaskDescription): match either.
    .where(
      or(
        eq(_tasks.description, prompt),
        sql`starts_with(${_tasks.description}, ${`${prompt}\n\n---\n`})`,
      ),
    )
    .orderBy(desc(_tasks.createdAt))
    .limit(1);
  if (task === undefined)
    throw new PromoFilmSeedRefused(
      `no task was filed with the prompt ${JSON.stringify(prompt)} — the film's Wish files it first`,
    );
  const n = 50;
  const run: FilmRun = {
    n,
    taskId: task.id as FilmRun["taskId"],
    attemptId: filmAttemptId(n),
    conversationId: filmConversationId(n),
    sessionId: filmSessionId(n),
    task: prompt,
    prompt,
    title: "Circle — a P2P messaging app",
    shortTitle: "P2P messaging",
    category: WISHES_CATEGORY_ID,
    status: "waiting",
    model: ConversationModelSchema.parse("opus-5-5"),
    phase: "design",
    startedAgo: 9 * MIN,
    updatedAgo: 0,
  };
  await writeRun(run, (ms) => new Date(now - ms), { existingTask: true });
  // Just finished: at the top of the queue, as a fresh reply is.
  await upsertRank(run.conversationId, await rankForTop(run.conversationId));
  await rm(runWorkspace(run), { recursive: true, force: true });
  await writeRunCheckout(run, await commonGitDir());
  await writeSessionFile(
    runWorkspace(run),
    run.sessionId,
    transcriptJsonl(
      run,
      prototypeTurns(prompt, await circleFirstVersionHtml()),
      runWorkspace(run),
      now,
    ),
  );
  return { taskId: run.taskId, conversationId: run.conversationId };
}

/**
 * The shops agent's write, as ONE `edit_page`: read the Buying a piano page
 * as the agent reads it, anchor on the user's last shop (its to-do line and
 * the place line under it) and insert after it every added shop in the same
 * form, a blank line (`<text/>`: a blank line beside a tag is spacing to
 * `edit_page`) and a map. One apply = one locked transaction, so the open
 * page receives the whole edit as one push. The conversation stamped as its
 * author is the Wish's agent, whose run the film never shows (no row: an
 * authorship id carries no foreign key, and a creator chip without its
 * conversation draws nothing).
 */
export async function writeFilmShops(): Promise<{ createdIds: string[] }> {
  await assertFilmNamespace();
  const caller = { conversationId: filmConversationId(51) };
  const blockId = FILM_PAGE_IDS.buying;
  const read = (await pageTools.read({ block_id: blockId }, caller)).content[0]
    .text;
  const last = PIANO_SHOP_LIST[PIANO_SHOP_LIST.length - 1]!;
  const lines = read.split("\n");
  const placeAt = lines.findIndex((l) =>
    l.includes(`place-id="${last.placeId}"`),
  );
  const todoLine = lines[placeAt - 1];
  if (placeAt < 1 || todoLine === undefined || !todoLine.includes("[")) {
    throw new PromoFilmSeedRefused(
      `the Buying a piano page has no "${last.text}" to-do with its place under it to write the agent's shops after — re-seed first`,
    );
  }
  const indentOf = (l: string) => /^\s*/.exec(l)![0];
  const at = indentOf(todoLine);
  const child = indentOf(lines[placeAt]!);
  const anchor = `${todoLine}\n${lines[placeAt]}`;
  const added = PIANO_SHOPS_ADDED.flatMap((shop) => [
    `${at}- [ ] ${shop.text}`,
    `${child}<place provider="google" place-id="${shop.placeId}"/>`,
  ]);
  const edit = {
    block_id: blockId,
    old_string: anchor,
    new_string: [anchor, ...added, `${at}<text/>`, `${at}<map/>`].join("\n"),
    replace_all: false,
  };
  const summary = (await pageTools.edit(edit, caller)).content[0].text;
  const result = z
    .object({ created_ids: z.array(z.string()) })
    .parse(JSON.parse(summary));
  return { createdIds: result.created_ids };
}

/** One agent run: its task and the rows of the attempt and conversation it ran in. */
async function writeRun(
  run: FilmRun,
  ago: (ms: number) => Date,
  opts: { existingTask?: true } = {},
) {
  if (!opts.existingTask)
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
  await insertWithUpdatedAt(db, _attempts, [
    {
      id: run.attemptId,
      taskId: run.taskId,
      worktreePath: runWorkspace(run),
      createdAt: ago(run.startedAgo),
      updatedAt: ago(run.updatedAgo),
    },
  ]);
  await insertWithUpdatedAt(db, _conversations, [
    {
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
    },
  ]);
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
  const here = await assertFilmNamespace();
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

/** This backend is the `promo-film` composition of its own checkout — loud otherwise. */
async function assertFilmNamespace(): Promise<string> {
  const here = runtimeNamespace();
  const film = namespaceFor(
    PROMO_FILM_COMPOSITION_ID,
    await checkoutRef(REPO_ROOT),
  );
  if (here !== film)
    throw new PromoFilmSeedRefused(
      `this backend is "${here}", not the film's instance "${film}" — the seed writes only into the promo-film composition's own database`,
    );
  return here;
}

/** Hide one item of a reorderable slot's layout: the committed layout, with
 *  `item` carrying the layout's own `hidden` flag, written to the user layer. */
async function hideLayoutItem(
  storePath: string,
  item: string,
  what: string,
): Promise<void> {
  const items = layoutItems(storePath).map((n) =>
    n === item ? { item: n, hidden: true } : n,
  );
  if (
    !items.some(
      (n) =>
        typeof n === "object" &&
        n !== null &&
        "hidden" in n &&
        (n as { item?: unknown }).item === item,
    )
  )
    throw new Error(`[promo-film seed] ${item} is not in ${storePath}`);
  await setConfigByPath(storePath, "items", items, {
    writer: systemOrigin(`promo-film seed: ${what}`),
  });
}

/** A reorderable slot's layout as this instance resolves it now. */
function layoutItems(storePath: string): unknown[] {
  const layout = getDescriptorByStorePath(storePath);
  if (!layout) throw new Error(`[promo-film seed] no config for ${storePath}`);
  return (getConfig(layout) as { items: unknown[] }).items;
}
