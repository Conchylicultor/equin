import { markCascadeBounded } from "@plugins/infra/plugins/retention/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { _pageBlocksTodoTaskExt } from "../../server/internal/tables";

// `page_blocks_ext_todo_task` needs no TTL sweep: every row belongs to exactly
// one card and is reclaimed when that card is hard-deleted. `markCascadeBounded`
// is what turns that from a claim into a checked fact — it reads the drizzle FK
// declaration at MODULE EVAL and throws (boot-fatal) if the
// `onDelete: "cascade"` to `page_blocks` is ever dropped.
//
// It lives in its own module, imported for effect by the machine barrel (the
// retention primitive is desktop-only), for two reasons: a barrel may hold no
// statements (boundary rule: barrel purity), and `tables.ts` must stay
// importable by drizzle-kit's sync schema loader, which cannot pull in the
// retention barrel's `db`/`jobs` closure.
//
// The `task_id` CASCADE is a SECOND reclaim path for the same rows, not a second
// bound to declare: one bound per table is the primitive's contract, and the
// block cascade is the one that always fires.
markCascadeBounded(_pageBlocksTodoTaskExt, _blocks);
