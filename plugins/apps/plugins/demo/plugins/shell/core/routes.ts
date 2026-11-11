import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The demo page's one route, `/demo`: the demo, framed under its caption or
 * maximized. Where the visitor is INSIDE the demo is kept in the page's URL
 * by the embed itself — its embed tail, `/demo/at/<location>[;full=1]`
 * (`apps-core/app-embed`) — so this route declares nothing for it.
 */
export const demoRoute = defineRoute({ id: "demo-start", segment: "" });
