/** How a count of results reads: "3 results" by default; a host names its own ("3 picks"). */
export type ResultWords = (count: number) => string;

export const defaultResultWords: ResultWords = (n) =>
  `${n} result${n === 1 ? "" : "s"}`;
