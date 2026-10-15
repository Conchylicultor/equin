import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { TurnUnconfirmedKindView } from "./components/turn-unconfirmed-kind-view";

export default {
  description:
    "Retired turn-unconfirmed report kind's Debug → Reports summary view, kept so existing rows still render: the one-line preview + elapsed + conversation id for a sent turn the browser's old pending-turn store never found in the transcript. Nothing files it any more — the turn ledger's server-side kinds replace it.",
  contributions: [
    Reports.KindView({
      match: "turn-unconfirmed",
      component: TurnUnconfirmedKindView,
    }),
  ],
} satisfies PluginDefinition;
