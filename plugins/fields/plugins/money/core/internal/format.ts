const usdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** An amount of US dollars as currency (`$42.17`) — the money type's one spelling. */
export const formatUsd = (n: number): string => usdFormatter.format(n);
