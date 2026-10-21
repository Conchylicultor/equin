import { implement } from "@plugins/infra/plugins/endpoints/server";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import {
  createSavedTheme,
  patchSavedThemeFragment,
  patchSavedThemeColorAdjust,
  renameSavedTheme,
  deleteSavedTheme,
} from "../../core";
import {
  saveTheme,
  editThemeFragment,
  setThemeColorAdjust,
  renameTheme,
  deleteTheme,
} from "./store";

export const handleCreate = implement(createSavedTheme, ({ body }) =>
  saveTheme(body),
);

export const handlePatchFragment = implement(
  patchSavedThemeFragment,
  ({ params, body }) => editThemeFragment(params.id, body),
);

export const handlePatchColorAdjust = implement(
  patchSavedThemeColorAdjust,
  ({ params, body }) => setThemeColorAdjust(params.id, body.colorAdjust),
);

export const handleRename = implement(renameSavedTheme, ({ params, body }) =>
  renameTheme(params.id, body.label),
);

export const handleDelete = implement(
  deleteSavedTheme,
  ({ params, query, req }) =>
    deleteTheme(params.id, {
      reassign: query.reassign ?? false,
      writer: originOf(req),
    }),
);
