import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { pageTagIdKind } from "../core";
import {
  createPageTag,
  deletePageTag,
  putPageTags,
  updatePageTag,
} from "../shared/endpoints";
import {
  pageTagAssignmentsServed,
  pageTagVocabularyServed,
} from "./internal/resource";
import {
  handleCreatePageTag,
  handleDeletePageTag,
  handlePutPageTags,
  handleUpdatePageTag,
} from "./internal/routes";
import { pageBlocksTags } from "./internal/tables";

export {
  loadPageTags,
  loadTagVocabularyNames,
  resolveTagNames,
  setPageTags,
  writeResolvedPageTags,
} from "./internal/store";
export type { PageTag } from "./internal/store";
export type {
  ResolvedTag,
  TagRequest,
  TagResolution,
} from "./internal/resolve";

export default {
  description:
    "Page tags, server half: the page_tags vocabulary and the page_blocks_ext_tags assignments (one ordered tag-id list per tagged page), both served live; the vocabulary CRUD and per-page PUT endpoints; and the reads/writes other plugins use — loadPageTags (the <page-meta> header), resolveTagNames (name → tag, refusing unknown names unless created explicitly) and writeResolvedPageTags / setPageTags. A page's tags are exposed as the `tags` field of every list whose rows are blocks (LiveColumns.Expose).",
  contributions: [
    IdKinds.Kind({ kind: pageTagIdKind }),
    ...pageTagVocabularyServed.declare,
    ...pageTagAssignmentsServed.declare,
    // `tags`, folded into every list whose rows are blocks (pages.tree).
    LiveColumns.Expose(pageBlocksTags),
  ],
  httpRoutes: {
    [putPageTags.route]: handlePutPageTags,
    [createPageTag.route]: handleCreatePageTag,
    [updatePageTag.route]: handleUpdatePageTag,
    [deletePageTag.route]: handleDeletePageTag,
  },
} satisfies ServerPluginDefinition;
