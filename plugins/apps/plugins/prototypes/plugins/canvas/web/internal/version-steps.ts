import {
  pickedValue,
  resolvePicks,
  type OptionPicks,
  type PrototypeHistory,
  type PrototypeOption,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * One stop of the `‹ v3 of 7 ›` stepper, oldest first.
 *
 * - `version` — a recorded version. `live` is true for exactly one of them: the
 *   newest, when the folder has nothing unsaved on top of it — there the saved
 *   version and the live folder are the same thing, so it is the live stop.
 * - `unsaved` — the live folder when it has changes no version holds yet. Only
 *   present when the history says `dirty`, and always last.
 */
export type VersionStep =
  | { kind: "version"; version: PrototypeVersion; live: boolean }
  | { kind: "unsaved" };

/**
 * Where the stepper stands, derived from the history and the version the pane
 * shows. Nothing here is state: the pane holds only the version it shows (or
 * `null` for live), read here by its sha, so a new version arriving, or the
 * folder turning dirty, re-derives the stops under it rather than leaving a
 * stale index behind.
 */
export interface VersionSteps {
  steps: readonly VersionStep[];
  /**
   * The stop on screen. `null` when `shown` names a sha the history does not
   * hold — the frame shows that sha all the same, so the stepper must say it is
   * lost rather than pretend it is on one of the stops.
   */
  current: number | null;
  /** The newest recorded version's number — the "7" of "v3 of 7". */
  newestN: number;
}

/**
 * The stops for `history`, and which one `shown` is on.
 *
 * `shown === null` is the LAST stop (live). A `shown` equal to the newest
 * version while the folder is clean is that same live stop — the two are one
 * stop, so the stepper never offers "back to latest" from the latest.
 */
export function versionSteps(
  history: PrototypeHistory,
  shown: string | null,
): VersionSteps {
  const { versions, dirty } = history;
  const newest = versions.at(-1);
  if (!newest) {
    // The store writes v0 when it adopts a folder, so an empty list is a broken
    // store, not an empty prototype. Loud, rather than a stepper reading "v0".
    throw new Error("prototype history has no versions — v0 is always there");
  }
  const steps: VersionStep[] = versions.map((version) => ({
    kind: "version",
    version,
    live: !dirty && version === newest,
  }));
  if (dirty) steps.push({ kind: "unsaved" });

  const current =
    shown === null
      ? steps.length - 1
      : versions.findIndex((v) => v.sha === shown);
  return {
    steps,
    current: current === -1 ? null : current,
    newestN: newest.n,
  };
}

/** The version to show at stop `step` — `null` for the live stop. */
export function versionForStep(step: VersionStep): PrototypeVersion | null {
  return step.kind === "version" && !step.live ? step.version : null;
}

/** Whether stop `step` is a saved version the live folder has moved past. */
export function isPastStep(step: VersionStep): boolean {
  return versionForStep(step) !== null;
}

/**
 * The stop one step `delta` away from the current one, or `null` past either
 * end. From a lost `shown` (`current === null`) the only way is back to live.
 */
export function stepBy(model: VersionSteps, delta: -1 | 1): VersionStep | null {
  if (model.current === null) {
    return delta === 1 ? (model.steps.at(-1) ?? null) : null;
  }
  return model.steps[model.current + delta] ?? null;
}

/** What the stepper's label reads for a stop. */
export function stepLabel(step: VersionStep, newestN: number): string {
  // Short on purpose: the label keeps one width in every state, and the
  // tooltip says what "unsaved" means.
  if (step.kind === "unsaved") return "Live · unsaved";
  if (step.live) return `v${step.version.n} · Latest`;
  return `v${step.version.n} of ${newestN}`;
}

/**
 * Whether a document declaring `options` can show the variant `picks` names:
 * it declares every picked option, each with the picked value among its
 * values. A pick equal to that document's default counts (it is what the
 * document shows unpicked); a value it does not declare — or an option it
 * lacks — would open at something else. The version list's "This variant".
 */
export function declaresVariant(
  options: readonly PrototypeOption[],
  picks: OptionPicks,
): boolean {
  return Object.entries(picks).every(([name, value]) => {
    const option = options.find((o) => o.name === name);
    if (option === undefined) return false;
    return (
      pickedValue(option, resolvePicks([option], { [name]: value })) === value
    );
  });
}
