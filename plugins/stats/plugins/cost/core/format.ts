const compactUsdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
export const formatUsdCompact = (n: number): string =>
  compactUsdFormatter.format(n);

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const formatTokensCompact = (n: number): string =>
  compactNumberFormatter.format(n);

const numberFormatter = new Intl.NumberFormat();
export const formatTokens = (n: number): string => numberFormatter.format(n);
