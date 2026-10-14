import { recordReport } from "@plugins/reports/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { createConversation as createConversationEndpoint } from "../../core/endpoints";
import { ClaudeCodeUnavailableError } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import {
  ModelUnavailableError,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { createConversation, TranscriptCutError } from "./lifecycle";

export const handleCreate = implement(
  createConversationEndpoint,
  async ({ body }) => {
    // body.model is already a well-formed ModelChoice | undefined (the body
    // schema checks the id grammar). Whether this machine can RUN it is the
    // live catalog's answer: an unknown or retired version is a 400 listing
    // what can run, before anything is written.
    if (body.model !== undefined)
      assertChoiceLaunchable(body.model, getModelCatalog());
    let session;
    try {
      session = await createConversation({
        taskId: body.taskId,
        attemptId: body.attemptId,
        prompt: body.prompt,
        runtimeId: body.runtime,
        model: body.model,
        forkFromConversationId: body.forkFromConversationId,
        forkAtMessageUuid: body.forkAtMessageUuid,
        workspace: body.workspace,
      });
    } catch (err) {
      // The message cannot be cut at (it is the first one, it left the
      // transcript, …). Expected, and nothing was written — a 409, not a report.
      if (err instanceof TranscriptCutError)
        throw new HttpError(409, err.message);
      // Claude Code missing or signed out: the machine's state, already shown
      // by the health report — a 409 carrying the fix, not a crash report.
      if (err instanceof ClaudeCodeUnavailableError) throw err;
      // The model it resolved to cannot run (retired since it was chosen —
      // a fork inheriting its source's version): the 409 names the
      // alternatives. A state of the catalog, not a crash.
      if (err instanceof ModelUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[conversations] createConversation failed", err);
      // Caught errors don't reach the unhandledRejection hook, so feed them to
      // recordReport explicitly. Dedup-by-fingerprint keeps a regression that
      // breaks every launch from spamming tasks; a single report row + task
      // surfaces the failure pattern instead. This INCLUDES intentional 4xx
      // rejections like the container-task guard: nothing should ever try to
      // start an attempt inside a meta/folder task, so a caller reaching it has
      // a bug worth surfacing — fail loudly with a report. We only preserve the
      // error's own HTTP status below (a client mistake is a 4xx, not a 500).
      // eslint-disable-next-line promise-safety/no-bare-catch
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: `createConversation failed: ${message}`,
        data: {
          errorType: err instanceof Error ? err.name : "Error",
          stack: err instanceof Error ? (err.stack ?? null) : null,
          status: err instanceof HttpError ? err.status : 500,
          label: "conversations.handleCreate",
        },
      }).catch((e) => {
        console.error("[conversations] recordReport failed", e);
      });
      throw err instanceof HttpError ? err : new HttpError(500, message);
    }
    return session;
  },
);
