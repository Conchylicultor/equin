import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * Circle — the P2P messaging app the film's user asks for: its prototype is
 * made in the film, then "implemented". The film's own stand-in for that
 * implementation, in the promo-film composition only.
 */
export const circleApp = defineApp({
  id: "circle",
  name: "Circle",
  basePath: "/circle",
  icon: symbol("forum"),
  iconColor: "violet",
});

/** The prototype the app is built from (the seed's Circle fixture). */
export const CIRCLE_PROTOTYPE = "proto-1792779833-4wgtuf";
