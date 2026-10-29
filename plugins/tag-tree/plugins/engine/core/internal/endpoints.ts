import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SavedSymbolNameSchema } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { CHILD_COLOR_MODES } from "./fields";
import { HexColorSchema } from "./schema";

// The ONE endpoint set every tag tree is written through, keyed by the tree's
// id (`:tree`): the server resolves it against the registered trees
// (`TagTrees.Tree`). Rows reach clients only through the tree's live
// collection, which every write here reaches through the change feed.

const TagNameSchema = z.string().trim().min(1);

/**
 * A tree's own extra fields a client may set (Places' Google types): checked
 * by the server against the tree's `editableExtras` — any other key is a 400.
 */
const ExtraSchema = z.record(z.string(), z.unknown());

export const CreateTagBodySchema = z.object({
  name: TagNameSchema,
  /** The parent tag; absent or null creates a root. */
  parentId: z.string().nullable().optional(),
  color: HexColorSchema.nullable().optional(),
  icon: SavedSymbolNameSchema.nullable().optional(),
  extra: ExtraSchema.optional(),
});
export type CreateTagBody = z.infer<typeof CreateTagBodySchema>;

/** Create a tag, last among its siblings. A sibling of the same name (case-insensitive) is a 400. */
export const createTag = defineEndpoint({
  route: "POST /api/tag-trees/:tree/tags",
  unpredicted: {
    reason: "server-minted-id",
    why: "the server mints the id and rank, and callers tag a place with the returned id",
  },
  body: CreateTagBodySchema,
  response: z.object({ id: z.string() }),
});

export const CreateTagPathBodySchema = z.object({
  /** The path, root first (`parseTagPath`): each segment names a child of the previous. */
  segments: z.array(TagNameSchema).min(1),
});
export type CreateTagPathBody = z.infer<typeof CreateTagPathBodySchema>;

export const CreateTagPathResultSchema = z.object({
  /** The path's leaf — existing or just made. */
  id: z.string(),
  /** The tags this call made, root first (empty when the whole path existed). */
  created: z.array(z.string()),
});
export type CreateTagPathResult = z.infer<typeof CreateTagPathResultSchema>;

/**
 * Make sure a path exists: every segment no tag matches (`resolveTagPath`,
 * case-insensitive) is created under the previous one, appended. Answers the
 * leaf.
 */
export const createTagPath = defineEndpoint({
  route: "POST /api/tag-trees/:tree/paths",
  unpredicted: {
    reason: "response",
    why: "the caller uses the returned id and created segments",
  },
  body: CreateTagPathBodySchema,
  response: CreateTagPathResultSchema,
});

export const UpdateTagBodySchema = z.object({
  /** Rename; a sibling's name (case-insensitive) is a 400. */
  name: TagNameSchema.optional(),
  /** `null` inherits the nearest ancestor's colour. */
  color: HexColorSchema.nullable().optional(),
  /** `ramp` shades the colourless children by rank; `null` lets them inherit. */
  childColors: z.enum(CHILD_COLOR_MODES).nullable().optional(),
  icon: SavedSymbolNameSchema.nullable().optional(),
  extra: ExtraSchema.optional(),
});
export type UpdateTagBody = z.infer<typeof UpdateTagBodySchema>;

/** Edit a tag in place. Its position changes only through {@link moveTag}. */
export const updateTag = defineEndpoint({
  route: "PATCH /api/tag-trees/:tree/tags/:id",
  unpredicted: {
    reason: "precondition",
    why: "A rename onto a sibling's name is a 400 the picker shows inline, and one endpoint serves every tree, so no single entity names the row.",
  },
  body: UpdateTagBodySchema,
});

/**
 * Where a moved tag lands: exactly `useTreeModel`'s `onMove` destination
 * (`primitives/tree`) — positional intent, never a rank. `targetId: null` +
 * `"after"` appends under `parentId` ("nest inside"); `"before"` prepends.
 */
export const MoveTagBodySchema = z.object({
  parentId: z.string().nullable(),
  targetId: z.string().nullable(),
  zone: z.enum(["before", "after"]),
});
export type MoveTagBody = z.infer<typeof MoveTagBodySchema>;

/** Move a tag (reorder or re-parent). Under itself or a descendant is a 400. */
export const moveTag = defineEndpoint({
  route: "POST /api/tag-trees/:tree/tags/:id/move",
  unpredicted: {
    reason: "server-decided",
    why: "The server mints the rank over the parent's complete sibling set (the body is positional intent), a move under a descendant is a 400, and one endpoint serves every tree so no single collection names the rows.",
  },
  body: MoveTagBodySchema,
});

/**
 * Delete a tag: its children move up to its parent at its position, and every
 * carrier of it gets its parent instead (nothing at the root).
 */
export const deleteTag = defineEndpoint({
  route: "DELETE /api/tag-trees/:tree/tags/:id",
  unpredicted: {
    reason: "server-decided",
    why: "The server re-parents the tag's children (at its position) and every carrier in other plugins' tables, and one endpoint serves every tree so no single collection names the rows.",
  },
});
