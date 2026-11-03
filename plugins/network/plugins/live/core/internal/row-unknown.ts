// A row whose value of a field is NOT KNOWN YET, or failed — for a field whose
// values are read per row (a client field probing each deployment). A reader
// answers it in place of a value (`ClientFieldReaders`), and the host that
// consumes the readers (data-view's client-values fold) splits it out once:
// `value` never sees it, the row's `rowState` says it. So a row the probe has
// not answered is drawn as "checking", never as the `null` a known-empty row
// is — and a known-empty row (no question to ask) is a plain `null`.

/** How much a reader knows about one row's value of a field. */
export type RowFieldState =
  | { readonly status: "known" }
  | { readonly status: "loading" }
  | {
      readonly status: "error";
      readonly error: Error;
      readonly refetch?: () => Promise<void>;
    };

/** A row a reader has no value for: pending, or failed. Minted only by {@link rowPending} / {@link rowFailed}. */
export class RowUnknown {
  private constructor(
    readonly state: Exclude<RowFieldState, { status: "known" }>,
  ) {}

  /** @internal — the two mints below. */
  static of(state: Exclude<RowFieldState, { status: "known" }>): RowUnknown {
    return new RowUnknown(state);
  }
}

/** The row's value is not known yet (its probe has not answered). */
export const rowPending: RowUnknown = RowUnknown.of({ status: "loading" });

/** The row's value failed to load — drawn as the failure, with `refetch` as its Retry. */
export function rowFailed(
  error: Error,
  refetch?: () => Promise<void>,
): RowUnknown {
  return RowUnknown.of(
    refetch === undefined
      ? { status: "error", error }
      : { status: "error", error, refetch },
  );
}

/** Whether a reader's answer is a {@link RowUnknown} rather than a value. */
export function isRowUnknown(value: unknown): value is RowUnknown {
  return value instanceof RowUnknown;
}
