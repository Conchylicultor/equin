import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { DEFAULT_DRAFT_TTL } from "@plugins/primitives/plugins/persistent-draft/web";
import { AskPositionSchema, type AskPosition } from "../../core";

/** Where the user left the card (one entry): it opens there again after a reload. */
export const askPositionStore = defineStore<AskPosition>({
  owner: "hints.ask.position",
  label: "Ask equin card positions",
  area: "local",
  cap: "4 KB",
  ttl: Infinity,
  whenFull: "evict-oldest",
  schema: AskPositionSchema,
});

/** The first question while it is typed (one entry): a reload keeps it. */
export const askQuestionDraft = defineStore<string>({
  owner: "hints.ask.question",
  label: "Ask equin questions",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.string(),
});

/**
 * The page each run's agent last heard of (`pageKey`, by conversation id):
 * the first question's, then each reply's that carried a `<page-context>`. A
 * reply from another page carries one. Lost (another browser, evicted), the
 * next reply carries it again — said twice, never missed.
 */
export const askSeenPageStore = defineStore<string>({
  owner: "hints.ask.seen-page",
  label: "Ask equin pages sent",
  area: "local",
  cap: "16 KB",
  ttl: 30 * 24 * 60 * 60 * 1000,
  whenFull: "evict-oldest",
  schema: z.string(),
});

/**
 * The card as this tab left it (one entry, `card`): open, minimized or
 * closed, and the run it held. A reload brings it back as it was; a new tab
 * (session storage is the tab's own) starts from the once-per-load restore.
 */
export const askCardStore = defineStore<AskCardSnapshot>({
  owner: "hints.ask.card",
  label: "Ask equin cards",
  area: "session",
  cap: "4 KB",
  ttl: Infinity,
  whenFull: "evict-oldest",
  schema: z.object({
    mode: z.enum(["closed", "open", "min"]),
    conversationId: z.string().nullable(),
  }),
});

export interface AskCardSnapshot {
  mode: "closed" | "open" | "min";
  conversationId: string | null;
}
