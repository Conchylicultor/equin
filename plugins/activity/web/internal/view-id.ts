import { defineDataView } from "@plugins/primitives/plugins/data-view/web";

/**
 * The surface id (scraped by codegen out of `web/**`). Its views — Recent,
 * and one per kind — are view instances authored in
 * `config/activity/activity.jsonc`, each nothing but a filter.
 */
export const ACTIVITY_VIEW = defineDataView("activity");
