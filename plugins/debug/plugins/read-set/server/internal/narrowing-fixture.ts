import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { and, eq, like } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { DEFAULT_CONVERSATION_RUNTIME } from "@plugins/conversations/plugins/runtime-catalog/core";
import { recordSessionId } from "@plugins/conversations/plugins/session-chain/server";
import { refreshConversationChain } from "@plugins/conversations/plugins/transcript-watcher/server";
import { DEFAULT_WORKSPACE } from "@plugins/conversations/plugins/workspace/core";
import {
  attemptIdKind,
  conversationIdKind,
} from "@plugins/tasks/plugins/task-ids/core";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { setTaskSubject } from "@plugins/tasks/plugins/task-subject/server";
import { setTaskSourceUrl } from "@plugins/tasks/plugins/task-source-url/server";
import { deployServerIdKind } from "@plugins/apps/plugins/deploy/plugins/servers/core";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { versionIdKind } from "@plugins/history/plugins/engine/core";
import { _entityVersions } from "@plugins/history/plugins/engine/server";
import { _attachments } from "@plugins/infra/plugins/attachments/server";
import {
  _claudeCliCalls,
  recordClaudeCliCall,
  writeRingHorizon,
} from "@plugins/infra/plugins/claude-cli/server";
import {
  _attempts,
  _tasks,
  createAttempt,
  createTask,
  deleteConversationRow,
  getConversation,
  insertConversation,
  moveConversationToAttempt,
  taskAttachments,
  updateConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  _pageBlocksAgentAuthors,
  recordAgentNotesAuthor,
} from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/server";
import { _dataViewRowOrder } from "@plugins/primitives/plugins/data-view/plugins/view-order/server";
import {
  narrowingFixture,
  NARROWING_FIXTURE_DATA_VIEW,
  NARROWING_FIXTURE_SUBJECT_KIND,
  NARROWING_FIXTURE_MARK,
  type NarrowingFixtureBody,
} from "../../core";

// The conversation ids an author stamp is made under: minted here, never a
// real conversation's (`conversation_id` has no foreign key).
const AUTHOR_PREFIX = `${NARROWING_FIXTURE_MARK}-`;

// What marks the by-id suite's rows: a server / task named so, a version's
// source, and the id (or correlation id) prefix of an attachment, a claude call
// and a subject.
const FIXTURE_NAME = "narrowing fixture";

function refuseUnlessFixture(what: string, id: string, ok: boolean): void {
  if (!ok) {
    throw new HttpError(
      409,
      `${what} "${id}" is not a narrowing-fixture row (the by-id suite writes only rows it created)`,
    );
  }
}
const isFixtureId = (id: string) => id.startsWith(AUTHOR_PREFIX);

async function fixtureServer(id: string): Promise<void> {
  const [row] = await db
    .select({ name: _deployServers.name })
    .from(_deployServers)
    .where(eq(_deployServers.id, deployServerIdKind.parse(id)));
  refuseUnlessFixture("Server", id, row?.name === FIXTURE_NAME);
}
async function fixtureVersion(id: string): Promise<void> {
  const [row] = await db
    .select({ sourceId: _entityVersions.sourceId })
    .from(_entityVersions)
    .where(eq(_entityVersions.id, versionIdKind.parse(id)));
  refuseUnlessFixture("Version", id, row?.sourceId === NARROWING_FIXTURE_MARK);
}
/** What the fixture's task is filed from: this plugin. */
const FIXTURE_FILED_FROM = "debug.read-set";

async function fixtureTask(id: string): Promise<void> {
  const [row] = await db
    .select({ filedFrom: _tasks.filedFrom, title: _tasks.title })
    .from(_tasks)
    .where(eq(_tasks.id, id));
  refuseUnlessFixture(
    "Task",
    id,
    row?.filedFrom === FIXTURE_FILED_FROM && row.title === FIXTURE_NAME,
  );
}

// The fixture's own conversations only: a real conversation's attempt and
// session chain are never written (the chain is append-only — a synthetic id
// recorded on a real conversation could never be taken back).
async function fixtureConversation(id: string): Promise<void> {
  const row = await getConversation(id);
  if (row === null) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (row.launchedFrom !== FIXTURE_FILED_FROM) {
    throw new HttpError(
      409,
      `Conversation "${id}" is not a narrowing-fixture conversation (launched from ${String(row.launchedFrom)})`,
    );
  }
}

type Action<A extends NarrowingFixtureBody["action"]> = Extract<
  NarrowingFixtureBody,
  { action: A }
>;

async function createFixtureRow(
  row: Action<"create-fixture-row">["row"],
): Promise<string> {
  switch (row.kind) {
    case "deploy-server": {
      const id = deployServerIdKind.mint();
      await db.insert(_deployServers).values({
        id,
        name: FIXTURE_NAME,
        host: "narrowing-fixture.invalid",
        sshPublicKey: "narrowing-key-0",
      });
      return id;
    }
    case "version": {
      const id = versionIdKind.mint();
      await db.insert(_entityVersions).values({
        id,
        sourceId: NARROWING_FIXTURE_MARK,
        entityId: row.entityId,
        snapshot: { value: "0" },
      });
      return id;
    }
    case "attachment": {
      const id = `${AUTHOR_PREFIX}${crypto.randomUUID()}`;
      await db.insert(_attachments).values({
        id,
        filename: "narrowing-0",
        mime: "text/plain",
        size: 0,
        diskPath: "/nonexistent/narrowing-fixture",
      });
      return id;
    }
    case "task": {
      const task = await createTask({
        title: FIXTURE_NAME,
        titleAuto: false,
        filing: {
          author: { kind: "system" },
          filedFrom: asPluginId(FIXTURE_FILED_FROM),
        },
        mandate: interactiveMandate,
      });
      return task.id;
    }
    case "attempt": {
      await fixtureTask(row.taskId);
      const id = attemptIdKind.mint();
      await createAttempt({
        id,
        taskId: row.taskId,
        worktreePath: "/nonexistent/narrowing-fixture",
        workspace: DEFAULT_WORKSPACE,
      });
      return id;
    }
  }
}

async function writeFixtureRow(
  target: Action<"write-fixture-row">["target"],
  id: string,
  value: string,
): Promise<void> {
  switch (target) {
    case "server-ssh-key":
      await fixtureServer(id);
      await db
        .update(_deployServers)
        .set({ sshPublicKey: value })
        .where(eq(_deployServers.id, deployServerIdKind.parse(id)));
      return;
    case "version-snapshot":
      await fixtureVersion(id);
      await db
        .update(_entityVersions)
        .set({ snapshot: { value } })
        .where(eq(_entityVersions.id, versionIdKind.parse(id)));
      return;
    case "attachment-filename":
      refuseUnlessFixture("Attachment", id, isFixtureId(id));
      await db
        .update(_attachments)
        .set({ filename: value })
        .where(eq(_attachments.id, id));
      return;
    case "claude-cli-call":
      // Each call inserts a row (and rewrites the ring horizon), as a real one.
      refuseUnlessFixture("Correlation id", id, isFixtureId(id));
      await recordClaudeCliCall({
        model: FALLBACK_MODEL,
        sourceName: NARROWING_FIXTURE_MARK,
        sourceContext: null,
        prompt: "",
        system: null,
        output: null,
        error: null,
        durationMs: 0,
        correlationId: id,
      });
      return;
    case "task-subject":
      await fixtureTask(id);
      refuseUnlessFixture("Subject id", value, isFixtureId(value));
      await setTaskSubject(id, {
        kind: NARROWING_FIXTURE_SUBJECT_KIND,
        id: value,
      });
      return;
    case "task-source-url":
      await fixtureTask(id);
      await setTaskSourceUrl(id, value);
      return;
    case "task-attachment-link": {
      // Toggles the (task, attachment) link: one insert or one delete.
      await fixtureTask(id);
      refuseUnlessFixture("Attachment", value, isFixtureId(value));
      const links = await db
        .select({ attachmentId: taskAttachments.table.attachmentId })
        .from(taskAttachments.table)
        .where(eq(taskAttachments.table.ownerId, id));
      const ids = links.map((l) => l.attachmentId);
      await taskAttachments.set(
        id,
        ids.includes(value) ? ids.filter((a) => a !== value) : [...ids, value],
      );
      return;
    }
  }
}

async function deleteFixtureRows(
  kind: Action<"delete-fixture-rows">["kind"],
  id: string,
): Promise<void> {
  switch (kind) {
    case "deploy-server":
      await fixtureServer(id);
      await db
        .delete(_deployServers)
        .where(eq(_deployServers.id, deployServerIdKind.parse(id)));
      return;
    case "version":
      await fixtureVersion(id);
      await db
        .delete(_entityVersions)
        .where(eq(_entityVersions.id, versionIdKind.parse(id)));
      return;
    case "attachment":
      refuseUnlessFixture("Attachment", id, isFixtureId(id));
      await db.delete(_attachments).where(eq(_attachments.id, id));
      return;
    case "task":
      // Its attempts first (they hold no conversation: the fixture made none).
      await fixtureTask(id);
      await db.delete(_attempts).where(eq(_attempts.taskId, id));
      await db.delete(_tasks).where(eq(_tasks.id, id));
      return;
    case "claude-cli-calls":
      refuseUnlessFixture("Correlation id", id, isFixtureId(id));
      await db
        .delete(_claudeCliCalls)
        .where(eq(_claudeCliCalls.correlationId, id));
      await writeRingHorizon(db);
      return;
  }
}

export const handleNarrowingFixture = implement(
  narrowingFixture,
  async ({ body }) => {
    // Main's data is the user's: the measurement runs on a worktree's fork.
    if (isMain()) {
      throw new HttpError(403, "the narrowing fixture never writes main");
    }
    switch (body.action) {
      case "create-conversation": {
        const id = conversationIdKind.mint();
        await insertConversation({
          id,
          attemptId: body.attemptId,
          runtime: DEFAULT_CONVERSATION_RUNTIME,
          model: FALLBACK_MODEL,
          launch: { cause: "direct", from: asPluginId(FIXTURE_FILED_FROM) },
          // Closed from the start: no runtime holds it, so the status
          // reconciler (which reads only active rows) never writes it.
          status: "done",
          title: "narrowing fixture",
        });
        return { conversationId: id, rowId: null };
      }
      case "record-session": {
        await fixtureConversation(body.conversationId);
        // What the status reconciler does on adopting a session id: the tail
        // on the row and the chain link in one transaction, then the watcher
        // re-pointed.
        const sessionId = crypto.randomUUID();
        await updateConversation(
          body.conversationId,
          { claudeSessionId: sessionId },
          {
            alongside: (tx) =>
              recordSessionId(body.conversationId, sessionId, tx),
          },
        );
        await refreshConversationChain(body.conversationId);
        return { conversationId: body.conversationId, rowId: null };
      }
      case "move-conversation": {
        await fixtureConversation(body.conversationId);
        await moveConversationToAttempt(body.conversationId, body.attemptId);
        return { conversationId: body.conversationId, rowId: null };
      }
      case "delete-conversation": {
        await fixtureConversation(body.conversationId);
        await deleteConversationRow(body.conversationId);
        return { conversationId: body.conversationId, rowId: null };
      }
      case "stamp-agent-author": {
        const conversationId = `${AUTHOR_PREFIX}${crypto.randomUUID()}`;
        await recordAgentNotesAuthor(body.blockId, conversationId);
        return { conversationId, rowId: null };
      }
      case "clear-agent-authors": {
        await db
          .delete(_pageBlocksAgentAuthors)
          .where(
            and(
              eq(_pageBlocksAgentAuthors.blockId, body.blockId),
              like(_pageBlocksAgentAuthors.conversationId, `${AUTHOR_PREFIX}%`),
            ),
          );
        return { conversationId: null, rowId: null };
      }
      case "clear-row-order": {
        if (!body.dataViewId.startsWith(NARROWING_FIXTURE_DATA_VIEW)) {
          throw new HttpError(
            409,
            `Data view "${body.dataViewId}" is not a narrowing-fixture data view (prefix ${NARROWING_FIXTURE_DATA_VIEW})`,
          );
        }
        await db
          .delete(_dataViewRowOrder)
          .where(eq(_dataViewRowOrder.dataViewId, body.dataViewId));
        return { conversationId: null, rowId: null };
      }
      case "create-fixture-row":
        return {
          conversationId: null,
          rowId: await createFixtureRow(body.row),
        };
      case "write-fixture-row": {
        await writeFixtureRow(body.target, body.id, body.value);
        return { conversationId: null, rowId: null };
      }
      case "delete-fixture-rows": {
        await deleteFixtureRows(body.kind, body.id);
        return { conversationId: null, rowId: null };
      }
    }
  },
);
