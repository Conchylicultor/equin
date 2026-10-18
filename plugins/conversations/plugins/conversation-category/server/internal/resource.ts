import { serveCollection } from "@plugins/network/plugins/live/server";
import { conversationCategories } from "../../shared";
import { conversationCategoriesEntity } from "./tables";

// Server half of the assignment read: the lookup-only collection served from
// the table. The loader reads only the subscribed id set (`WHERE id IN (ids)`),
// and the `:rows` point routing sends an assignment write to a tuple iff the
// changed row ids intersect its set — so classifying one conversation never
// sweeps the table.
//
// The row id `id` IS the pk: `categoryRowId(conversationId, categoryId)`, so one
// subscribed id names exactly one (conversation, category) assignment. The
// projection is exactly `ConversationCategorySchema`'s keys, bound by name —
// `createdAt` stays server-only. Point sets are unordered; callers index by
// `categoryId`.
export const conversationCategoriesServed = serveCollection(
  conversationCategories,
  { from: conversationCategoriesEntity },
);
