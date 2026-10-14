import { ne } from "drizzle-orm";
import type { DefaultScope } from "@plugins/network/plugins/live/server";
import type {
  _conversations,
  conversationOwnerJoins,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { allConversations, ConversationListLiveRow } from "../../core";

// Apart from `collection.ts` (which REGISTERS the served collections at module
// eval), so a suite compiling the same declaration against its own database
// reads the one spelling without registering a second copy.

/**
 * The All-conversations list's default scope: system conversations are hidden
 * by DEFAULT, not by base membership — a view whose filter names `kind` (any
 * op; Kind = System) gets exactly what it asked for.
 */
export const allConversationsDefaults: readonly DefaultScope<
  typeof _conversations,
  ConversationListLiveRow,
  typeof conversationOwnerJoins,
  keyof (typeof allConversations)["filterable"]
>[] = [{ unless: "kind", where: (j) => ne(j.base.kind, "system") }];
