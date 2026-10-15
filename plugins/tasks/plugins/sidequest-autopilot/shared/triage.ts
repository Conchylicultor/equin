import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/**
 * What triage made of a sidequest.
 *
 * - `ready` — clear in scope; an unattended agent can do it without asking.
 * - `decide` — doable, but one call is the person's to make (its `question`).
 * - `split` — too big for one unattended session (its `question` proposes how
 *   to split it).
 * - `obsolete` — already fixed on main, or the code it names is gone.
 */
export const TRIAGE_VERDICTS = [
  "ready",
  "decide",
  "split",
  "obsolete",
] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

/** How much a person relies on what it would change. */
export const TRIAGE_RISKS = ["low", "medium", "high"] as const;
export type TriageRisk = (typeof TRIAGE_RISKS)[number];

/** At most this many one-click answers to triage's question. */
export const MAX_TRIAGE_ANSWERS = 4;

// One row per sidequest triage read, in `tasks_ext_sidequest_triage` — the
// latest read wins. Written by the triage job (a read-only Sonnet run) and,
// for `answer` only, by the person's click. `sourceTitle` / `sourceDescription`
// are the task's text as triage read it: once the task is edited they differ
// and the row is stale (`triageStaleness`). `mainSha` is the main commit it
// read the code at.
export const sidequestTriageShape = defineExtensionShape({
  key: "taskId",
  fields: {
    verdict: enumTextField(TRIAGE_VERDICTS),
    context: textField(),
    question: nullable(textField()),
    answers: jsonField({ schema: z.array(z.string()), default: [] }),
    answer: nullable(textField()),
    risk: enumTextField(TRIAGE_RISKS),
    sizeMinutes: intField(),
    value: intField(),
    areas: jsonField({ schema: z.array(z.string()), default: [] }),
    mainSha: textField(),
    sourceTitle: textField(),
    sourceDescription: textField(),
    triagedAt: dateField(),
  },
});
export const SidequestTriageSchema = sidequestTriageShape.schema;
export type SidequestTriage = z.infer<typeof SidequestTriageSchema>;

/**
 * Every triage row, as the WHOLE ordered set (`all`): the launch list joins
 * triage to every ready sidequest it shows, so its reader holds the set entire
 * — a triaged sidequest never reads as untriaged past a window's edge.
 *
 * The key is `sidequest-autopilot.triage.all`, not the old window's
 * `sidequest-autopilot.triage`: no bundle ever declared this key with another
 * contract, so a tab on an older one gets `unknown-key` (a `skew` verdict) and
 * never parses these rows.
 */
export const sidequestTriageRows = liveCollection(
  "sidequest-autopilot.triage.all",
  {
    from: sidequestTriageShape,
    id: "taskId",
    all: {
      orderBy: [["taskId", "asc"]],
      unbounded: {
        reason:
          "at most one row per task (its latest triage read), and the launch list joins triage to every ready sidequest",
      },
    },
  },
);

/**
 * Whether a triage read still describes its task: `stale` once it is older
 * than `staleDays` or the task's title or description changed since. Stale is
 * shown, never acted on — nothing re-triages on its own.
 */
export type TriageStaleness =
  { stale: false } | { stale: true; reason: "edited" | "old" };

export function triageStaleness(
  row: Pick<SidequestTriage, "triagedAt" | "sourceTitle" | "sourceDescription">,
  task: { title: string; description: string | null },
  now: Date,
  staleDays: number,
): TriageStaleness {
  if (
    row.sourceTitle !== task.title ||
    row.sourceDescription !== (task.description ?? "")
  ) {
    return { stale: true, reason: "edited" };
  }
  const ageMs = now.getTime() - row.triagedAt.getTime();
  if (ageMs > staleDays * 24 * 60 * 60 * 1000) {
    return { stale: true, reason: "old" };
  }
  return { stale: false };
}

/**
 * Launch order among sidequests: triage's value for size, best first — value
 * per hour of estimated work. Untriaged ones rank after every triaged one.
 */
export function triageScore(
  row: Pick<SidequestTriage, "value" | "sizeMinutes"> | undefined,
): number {
  if (row === undefined) return -1;
  return row.value / Math.max(row.sizeMinutes, 15);
}
