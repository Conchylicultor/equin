import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
  defineStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { ConsentKeySchema } from "../../core";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a browser keeps its answer: 13 months, after which the site asks
 * again. The entry is written once, when the visitor answers, and never
 * rewritten by a visit — so the store's TTL (time since the last write) is the
 * answer's age. The box keeps a key at most as long (`CONSENT_KEY_DAYS`).
 */
const ANSWER_TTL_MS = 395 * DAY_MS;

const ConsentAnswerSchema = z.discriminatedUnion("answer", [
  /** The visitor accepted: the key every hit carries from now on. */
  z.object({ answer: z.literal("accepted"), key: ConsentKeySchema }),
  /** The visitor said no: nothing but the answer itself is kept. */
  z.object({ answer: z.literal("rejected") }),
]);
type ConsentAnswer = z.infer<typeof ConsentAnswerSchema>;

/**
 * This browser's answer to the site's consent prompt. One entry, the page's
 * own: the answer is about the site, not about an app rendered inside it.
 */
export const consentStore = defineStore({
  owner: "analytics.consent",
  pageWide: {
    reason:
      "the visitor's answer to the site's consent prompt, and the key it lets the site keep",
  },
  label: "Cookie consent",
  area: "local",
  cap: "1 KB",
  ttl: ANSWER_TTL_MS,
  whenFull: "refuse",
  schema: ConsentAnswerSchema,
});

/** The slice of the store consent needs (the real one in the page, a map in a test). */
export type ConsentStore = Pick<
  Store<ConsentAnswer>,
  "read" | "write" | "remove" | "subscribe"
>;

/**
 * Where this browser stands: `undecided` until the visitor answers (and again
 * once the answer is 13 months old), then `accepted` or `rejected`.
 */
export type AnalyticsConsent = "undecided" | "accepted" | "rejected";

/** This browser's answer, read from `store`. */
export function readConsent(store: ConsentStore): AnalyticsConsent {
  const entry = store.read("");
  return entry.kind === "value" ? entry.value.answer : "undecided";
}

/** The key this browser's hits carry: only once the visitor accepted. */
export function consentKeyOf(store: ConsentStore): string | undefined {
  const entry = store.read("");
  return entry.kind === "value" && entry.value.answer === "accepted"
    ? entry.value.key
    : undefined;
}

/**
 * Records the visitor's answer. Accepting mints a fresh key (an earlier one,
 * if any, is replaced); rejecting drops the key at once, so no later hit
 * carries it. A refused write is announced by the store itself, and the
 * browser then stays undecided — the prompt shows again on the next page load.
 */
export function answerConsent(store: ConsentStore, accepted: boolean): void {
  store.write(
    "",
    accepted
      ? { answer: "accepted", key: crypto.randomUUID() }
      : { answer: "rejected" },
  );
}

/**
 * What a render knows of the answer: the answer itself in the browser, or
 * `unknown` where there is no browser storage to read (the crawlable
 * snapshot's server render, and hydrating it) — a state to render, never a
 * stand-in for `undecided`.
 */
export type ConsentState = AnalyticsConsent | "unknown";

/** This browser's answer, live: another tab answering updates this one too. */
export function useAnalyticsConsent(): ConsentState {
  return useSyncExternalStore<ConsentState>(
    (onChange) => consentStore.subscribe("", onChange),
    () => readConsent(consentStore),
    () => "unknown",
  );
}

/**
 * Answers the site's consent prompt for this browser: `true` lets the site
 * keep a random key here, so a return is recognised on any network; `false`
 * keeps nothing but the answer, and the visit is counted by the daily hash.
 */
export function setAnalyticsConsent(accepted: boolean): void {
  answerConsent(consentStore, accepted);
}
