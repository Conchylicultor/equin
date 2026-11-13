// The `schema-files-loadable` question: nothing beyond the load itself. The
// schema question host answers a file whose `require()` threw with the error,
// so "does it load?" is whether a file answered at all.
import type { SchemaQuestion } from "@plugins/database/plugins/migrations/plugins/schema-question/core";

export default {
  answer: () => null,
} satisfies SchemaQuestion<null>;
