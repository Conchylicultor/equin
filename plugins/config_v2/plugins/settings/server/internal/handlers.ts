import { implement, HttpError } from "@plugins/infra/plugins/endpoints/core";
import {
  setConfigByPath,
  resetConfigByPath,
  acknowledgeConflictByPath,
  deleteOverrideByPath,
  mergeConflictByPath,
} from "@plugins/config_v2/server";
import { setConfigField } from "@plugins/config_v2/core";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import {
  resetConfigField,
  acknowledgeConflict,
  deleteOverride,
  mergeConflict,
} from "../../core";

// Every write below passes `originOf(req)` — NEVER a literal. A hardcoded
// `{ kind: "user" }` here would compile and would silently make agent writes
// unrevertible; `config-v2:write-origin-from-request` is the lint rule that
// stops that.

export const handleSetField = implement(
  setConfigField,
  async ({ body, req }) => {
    try {
      await setConfigByPath(body.storePath, body.key, body.value, {
        writer: originOf(req),
        scopeId: body.scopeId,
      });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);

export const handleResetField = implement(
  resetConfigField,
  async ({ body, req }) => {
    try {
      await resetConfigByPath(body.storePath, body.key, {
        writer: originOf(req),
        scopeId: body.scopeId,
      });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);

export const handleAcknowledgeConflict = implement(
  acknowledgeConflict,
  async ({ body, req }) => {
    try {
      acknowledgeConflictByPath(body.storePath, {
        writer: originOf(req),
        scopeId: body.scopeId,
      });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);

export const handleDeleteOverride = implement(
  deleteOverride,
  async ({ body, req }) => {
    try {
      deleteOverrideByPath(body.storePath, {
        writer: originOf(req),
        scopeId: body.scopeId,
      });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);

export const handleMergeConflict = implement(
  mergeConflict,
  async ({ body, req }) => {
    try {
      return mergeConflictByPath(body.storePath, {
        writer: originOf(req),
        scopeId: body.scopeId,
      });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);
