import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  choose,
  patchRow,
  removeRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import {
  normalizeTagName,
  pageTagAssignments,
  pageTagsEntityRef,
  TagColorSchema,
  TagNameSchema,
} from "../core";

/** Replace a page's tags with `tagIds`, in that order (`[]` clears them). */
export const putPageTags = defineEndpoint({
  route: "PUT /api/pages/:pageId/tags",
  body: z.object({ tagIds: z.array(z.string()) }),
  // The whole assignment row is the request's: `[]` deletes it, else it is
  // replaced (or entered).
  effect: (on) =>
    choose(on, ({ body }) => (body.tagIds.length === 0 ? "clear" : "set"), {
      clear: removeRow(on, pageTagAssignments, ({ params }) => params.pageId),
      set: upsertRow(
        on,
        pageTagAssignments,
        ({ params }) => params.pageId,
        (_row, { params, body }) => ({
          pageId: params.pageId,
          tagIds: body.tagIds,
        }),
        { set: ({ body }) => ({ tagIds: body.tagIds }) },
      ),
    }),
});

/** Add a tag to the vocabulary. A name already there (by key) is a 409. */
export const createPageTag = defineEndpoint({
  route: "POST /api/page-tags",
  unpredicted: {
    reason: "server-minted-id",
    why: "the server derives the tag id and the picker assigns it from the response",
  },
  body: z.object({ name: TagNameSchema, color: TagColorSchema.optional() }),
  response: z.object({ id: z.string() }),
});

/**
 * Rename or recolor a vocabulary tag; every page carrying it follows.
 * Predicted: the vocabulary row reads the new name / colour at once. A name
 * another tag took in the meantime is a 409, which the rejection toast reports
 * (the picker checks the clash before it asks).
 */
export const updatePageTag = defineEndpoint({
  route: "PATCH /api/page-tags/:tagId",
  body: z.object({
    name: TagNameSchema.optional(),
    color: TagColorSchema.optional(),
  }),
  effect: (on) =>
    patchRow(
      on,
      pageTagsEntityRef,
      ({ params }) => params.tagId,
      ({ body }) => ({
        set: {
          ...(body.name === undefined
            ? {}
            : { name: normalizeTagName(body.name) }),
          ...(body.color === undefined ? {} : { color: body.color }),
        },
      }),
    ),
});

/** Remove a tag from the vocabulary and from every page carrying it. */
export const deletePageTag = defineEndpoint({
  route: "DELETE /api/page-tags/:tagId",
  // The vocabulary row goes. The pages carrying it need no patch of their own:
  // every reader resolves a page's tag ids against the vocabulary and skips an
  // id it no longer holds (`resolveTags`), and the server's push strips the
  // ids (a tag-id list has no filter domain, so a `patchWhere` cannot name them).
  effect: (on) =>
    removeRow(on, pageTagsEntityRef, ({ params }) => params.tagId),
});
