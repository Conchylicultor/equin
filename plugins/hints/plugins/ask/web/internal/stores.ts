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
