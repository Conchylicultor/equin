import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TagColorSchema, TagNameSchema } from "../core";

/** Replace a page's tags with `tagIds`, in that order (`[]` clears them). */
export const putPageTags = defineEndpoint({
  route: "PUT /api/pages/:pageId/tags",
  body: z.object({ tagIds: z.array(z.string()) }),
});

/** Add a tag to the vocabulary. A name already there (by key) is a 409. */
export const createPageTag = defineEndpoint({
  route: "POST /api/page-tags",
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
});

/** Remove a tag from the vocabulary and from every page carrying it. */
export const deletePageTag = defineEndpoint({
  route: "DELETE /api/page-tags/:tagId",
});
