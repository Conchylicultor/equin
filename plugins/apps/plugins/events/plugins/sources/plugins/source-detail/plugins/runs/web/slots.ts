import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { EventSourceRunRow } from "@plugins/apps/plugins/events/plugins/events-core/core";

/**
 * Per-row actions on the run ledger. A slot rather than a hardcoded button for
 * the same reason `sources` mints `EventSourceActions`: this plugin ships the
 * one action it owns (open the run) and anything else a run grows — a re-run, a
 * copy-id — is a contribution, not a branch here.
 */
export const RunActions = defineItemActions<EventSourceRunRow>();

/**
 * The run pane, as ONE render slot. The pane body is a run summary plus this
 * host, so every region of a run is a peer contribution.
 *
 * This is what keeps the ledger generic over source types. Only SOME source
 * types pay for a model call, so "show me the prompt and what the model said"
 * cannot live in `runs` without this plugin naming an LLM — it is the
 * `model-call` sub-plugin's section instead, and a future non-LLM source type
 * simply produces runs whose section reports that no call was made.
 *
 * The entity prop is the `runId`, NOT the row: a section reads the run through
 * `useEventSourceRun` (one live row subscription, shared), so each owns its own
 * loading state and can mount before the pane has resolved anything.
 */
export const EventSourceRunDetail = defineDetailSections<{ runId: string }>();
