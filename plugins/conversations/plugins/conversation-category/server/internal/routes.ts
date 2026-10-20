import { implement } from "@plugins/infra/plugins/endpoints/server";
import { clearConversationCategory } from "../../shared/endpoints";
import { deleteCategoryRow } from "./store";

// Deliberately does NOT validate the category against config: clearing a row
// whose category was deleted from config is exactly when you need this to work.
// That also keeps it a pure DB write, so it is served on every host (the
// classify and set routes read the config, and are machine/'s).
export const handleClearCategory = implement(
  clearConversationCategory,
  async ({ params }) => {
    await deleteCategoryRow(params.conversationId, params.categoryId);
  },
);
