// The FIRST module `test/bun-preload.ts` imports, so it runs before any other
// module of a `bun test` process evaluates: from here on, every slot the
// process makes is attributed to its creating module (slot-declaration's
// `trackSlotSites`).
//
// Why a test process needs this from its very start: one `bun test` process
// runs every suite of a run, sharing one module registry. A suite that evaluates
// plugin barrels as data (`plugin-records`' evaluator, reached by
// `page/editor`'s `loadBlockHandles` whenever a barrel's record missed the
// shared store) can only name a slot whose creation was tracked — and tracking
// used to start at the first barrel import. A suite that ran EARLIER in the same
// process and imported a slot module (`web-sdk/core`) left that slot untracked,
// so the later suite failed with "a barrel exports a slot whose creation was not
// tracked" — a verdict that depended on which files shared the process and on
// the record store's warmth (2026-11-15). A process that tracks from its start
// has no slot made before tracking, so neither can decide a test's result.
//
// A module of its own, not a call in the preload's body: ES imports are
// evaluated before the importing module's body runs, so a call there would come
// after the preload's own imports had already made whatever slots they make.
import { trackSlotSites } from "@plugins/framework/plugins/slot-declaration/core";

trackSlotSites();
