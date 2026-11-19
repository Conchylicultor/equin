import type { ClaudeUsageRead } from "@plugins/conversations/plugins/runtime-sdk/core";
import {
  SYSTEM_ACCOUNT_ID,
  type ClaudeAccounts,
} from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import type { SpendWindow } from "../../core";

// Each account's window: a plan account counts from its own last weekly reset
// (read off the usage its agents last reported), an API-key account over the
// last 7 days, a plan account with no reading yet over the last 7 days too —
// marked approximate. Built here, in the browser: a served read never reads
// the clock.

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** How an account's window was decided. */
export type AccountWindowKind = "week" | "approximate" | "api";

/** One account's window, as the total's tooltip names it. */
export interface AccountWindow {
  accountId: string;
  name: string;
  kind: AccountWindowKind;
  /** Epoch ms the window starts at. */
  since: number;
}

/** The last 7 days to the start of this hour — stable for the whole hour. */
function lastWeek(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS - WEEK_MS;
}

/**
 * The start of the week a plan account is in now, from the reset its last
 * reading named: rolled forward a week at a time past every reset since.
 */
export function weekStart(resetsAt: number, now: number): number {
  let start = resetsAt - WEEK_MS;
  while (start + WEEK_MS <= now) start += WEEK_MS;
  return start;
}

/** Every account's window, the computer's own login first. */
export function accountWindows(
  accounts: ClaudeAccounts,
  usage: ClaudeUsageRead,
  now: number,
): AccountWindow[] {
  const listed = [
    { id: SYSTEM_ACCOUNT_ID, name: "This computer", metered: false },
    // Every added account is an API key: billed per use, no plan window.
    ...accounts.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      metered: true,
    })),
  ];
  return listed.map((a): AccountWindow => {
    if (a.metered)
      return {
        accountId: a.id,
        name: a.name,
        kind: "api",
        since: lastWeek(now),
      };
    const week = usage.byAccount[a.id]?.week;
    return week
      ? {
          accountId: a.id,
          name: a.name,
          kind: "week",
          since: weekStart(week.resetsAt, now),
        }
      : {
          accountId: a.id,
          name: a.name,
          kind: "approximate",
          since: lastWeek(now),
        };
  });
}

/** The read's question: one window per account, in account-id order. */
export function spendWindows(windows: readonly AccountWindow[]): SpendWindow[] {
  return [...windows]
    .sort((a, b) =>
      a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
    )
    .map((w) => ({
      accountId: w.accountId,
      since: new Date(w.since).toISOString(),
      metered: w.kind === "api",
    }));
}

const SINCE = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Personal: since Mon 09:00", "API key: last 7 days (billed API usage)". */
export function windowWords(w: AccountWindow): string {
  switch (w.kind) {
    case "week":
      return `${w.name}: since ${SINCE.format(w.since).replace(",", "")}`;
    case "approximate":
      return `${w.name}: last 7 days (no usage reading yet)`;
    case "api":
      return `${w.name}: last 7 days (billed API usage)`;
  }
}
